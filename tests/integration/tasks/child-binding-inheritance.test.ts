import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterAll, afterEach, expect, test } from "vitest";

import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  wrapToolExecute,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

delete process.env.DISCORD_BOT_TOKEN;

const TRUSTED = generateKeyPairSync("ed25519");
function publicKeyHex(pair: { publicKey: KeyObject }): string {
  return Buffer.from((pair.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
}
process.env.DISCORD_PUBLIC_KEY = publicKeyHex(TRUSTED);

const DISCORD_INTERACTIONS_ROUTE = "/eve/v1/discord";
const CLICKER_ID = "9000000000000000079";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});
const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

interface SeenBinding {
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly principalId: unknown;
  readonly mode: string;
  readonly channelId: unknown;
}
const seen: SeenBinding[] = [];

let base = "";
let org = "";

async function armAgent(): Promise<void> {
  ({ base } = await bootAgent({ sharedSqlite: true }));
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: "off" } });
  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  org = binding.deploymentOrg();
  if (cleanups.length > 0) return;
  const { bindFrom } = binding;
  cleanups.push(
    wrapToolExecute("post_file", async (_input: unknown, ctx: unknown) => {
      const b = bindFrom(ctx as Parameters<typeof bindFrom>[0]);
      seen.push({
        platform: b.platform,
        workspace: b.workspace,
        surface: b.surface,
        principalId: b.principalId,
        mode: b.mode,
        channelId: b.target?.["channelId"],
      });
      return { posted: true, count: 1, platform: b.platform };
    }),
  );
}

async function getStore() {
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  return provider.getOperationalStore();
}

async function postGuildClick(customId: string): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    type: 3,
    id: randomUUID(),
    application_id: "9000000000000000001",
    channel_id: DISCORD_LISTED_CHANNEL_ID,
    data: { custom_id: customId, component_type: 2 },
    guild_id: DISCORD_GUILD_ID,
    member: { user: { id: CLICKER_ID }, permissions: "0" },
    token: `it-${randomUUID()}`,
    version: 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), TRUSTED.privateKey).toString("hex");
  const res = await fetch(`${base}${DISCORD_INTERACTIONS_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    body,
    signal: AbortSignal.timeout(300_000),
  });
  return { status: res.status, body: await res.text() };
}

async function customIdFor(rowId: string): Promise<string> {
  const s = await getStore();
  const row = await s.getPendingAction(org, rowId);
  expect(row).not.toBeNull();
  const { buildDiscordApprovalCustomId } = await import("@open-everywhere/provider-discord/agent/approvals/discord-card.js");
  return buildDiscordApprovalCustomId(row!, "approve");
}

async function rowsSince(since: number, actions: readonly string[]): Promise<AuditRow[]> {
  const got = await readAuditRows({ actions, sinceIso: new Date(since - 1_000).toISOString(), limit: 300 });
  return got.filter((r) => new Date(r.ts).getTime() >= since);
}

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;

async function proposeRoutine(ids: string): Promise<{ id: string; handle: ScriptedHandle }> {
  const handle: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "agent", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
      { say: "the worker reported back" },
    ],
    child: [
      { calls: [{ tool: "create_routine", input: { prompt: `ope681 ${ids} ${randomUUID()}`, trigger: TRIGGER }, id: `${ids}-routine` }] },
      { say: "proposed" },
    ],
  });

  const wakeAt = Date.now();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `the ${ids} parent's terminal step`);
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's own terminal step` });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, `the ${ids} delegation`),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: `the ${ids} worker's settlement wake`,
  });
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  drained.handle.dispose();

  const requested = await waitFor(
    async () => (await rowsSince(wakeAt, ["approval.requested"])).find((r) => r.detail?.kind === "routine.create"),
    `the ${ids} approval.requested row to land`,
    120_000,
  );
  const id = requested.detail?.id;
  expect(typeof id).toBe("string");
  return { id: id as string, handle };
}

function expectBoundToTheDispatchingRoom(worker: SeenBinding): void {
  expect(worker.platform).toBe("discord");
  expect(worker.workspace).toBe(DISCORD_GUILD_ID);
  expect(worker.surface).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(worker.mode).toBe("channel");
  expect(worker.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);
}

test("a worker dispatched from an INTERNAL-DISPATCH-woken turn binds the seat's real surface", async () => {
  await armAgent();
  const { id, handle: proposal } = await proposeRoutine("s1");
  perTest.push(() => proposal.dispose());
  const customId = await customIdFor(id);

  expect(proposal.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  proposal.dispose();

  const wake: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "agent", input: { message: "write ope681.txt and post it here" }, id: `s1-delegate-${randomUUID()}` }] },
      { say: "handing this off" },
    ],
    child: [
      {
        calls: [
          {
            tool: "post_file",
            input: { files: [{ source: { path: "ope681.txt" }, filename: "ope681.txt" }], comment: "here it is" },
            id: `s1-post-${randomUUID()}`,
          },
        ],
      },
      { say: "posted the file" },
    ],
  });
  perTest.push(() => wake.dispose());

  seen.length = 0;
  const clickAt = Date.now();
  const res = await postGuildClick(customId);
  expect(res.status).toBe(200);
  expect((JSON.parse(res.body) as { type?: number }).type).toBe(7);

  await waitForChildren(wake, { count: 1, lastStepIndex: 1, label: "the decision-wake delegation's worker" });
  const drain = await awaitTaskSettlement({
    dispatched: wake,
    taskId: taskIdOfDelegation(wake, "the decision-wake delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the decision-wake worker's settlement wake",
  });
  perTest.push(() => drain.handle.dispose());

  const diverged = (await rowsSince(clickAt, ["egress.policy"])).filter((r) => r.detail?.reason === "subagent-binding-divergence");
  expect(diverged.map((r) => `${r.platform}/${r.workspace}/${r.surface}`)).toEqual([]);
  expect((await rowsSince(clickAt, ["binding.refused"])).map((r) => r.detail?.reason)).toEqual([]);

  expect(seen.length).toBe(1);
  expectBoundToTheDispatchingRoom(seen[0]!);
  expect(seen[0]!.principalId).toBe("9000000000000000042");
});

test("🔴 the control: a worker dispatched from an ordinary MENTION-woken turn still binds correctly", async () => {
  await armAgent();

  const dispatched = registerScript({
    parent: [
      { calls: [{ tool: "agent", input: { message: "write ope681-control.txt and post it here" }, id: `c1-delegate-${randomUUID()}` }] },
      { say: "handing this off" },
    ],
    child: [
      {
        calls: [
          {
            tool: "post_file",
            input: { files: [{ source: { path: "ope681-control.txt" }, filename: "ope681-control.txt" }], comment: "here it is" },
            id: `c1-post-${randomUUID()}`,
          },
        ],
      },
      { say: "posted the file" },
    ],
  });
  perTest.push(() => dispatched.dispose());

  seen.length = 0;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> write a file and post it" });
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the mention-woken delegation's worker" });
  const drain = await awaitTaskSettlement({
    dispatched,
    taskId: taskIdOfDelegation(dispatched, "the mention delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the mention delegation's settlement wake",
  });
  perTest.push(() => drain.handle.dispose());
  expect(drain.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  expect(seen.length).toBe(1);
  expectBoundToTheDispatchingRoom(seen[0]!);
  expect(seen[0]!.principalId).toBe("9000000000000000042");
});
