import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  workTaskIdOfCall,
  wrapToolExecute,
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

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;

const RECEIPT_STEP = [{ say: NO_REPLY_SENTINEL }] as const;

async function driveForward(handle: ScriptedHandle, input: { readonly callId: string; readonly label: string; readonly cursor: Awaited<ReturnType<typeof auditCursor>> }): Promise<void> {
  const receiptStep = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    `the ${input.label} receipt step to be served`,
  );
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(input.cursor, handle, input.callId, `the ${input.label} forward receipt`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${input.label} worker's own terminal step` });
  await waitFor(() => (handle.holdsCutShort() === 1 ? true : undefined), `the ${input.label} worker's hold ended on the release, not on its 120 s backstop`);
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `the ${input.label} seat step that read the worker's result` });
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, `the ${input.label} result arrives in a seat turn of its own (OPE-2338)`).not.toBe(receiptStep.turnId);
  for (const h of [handle, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }
  settlement.dispose();
}

async function proposeRoutine(ids: string): Promise<{ id: string; handle: ScriptedHandle }> {
  const handle: ScriptedHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
        ...RECEIPT_STEP,
      ],
      child: [
        { delayMs: 120_000, calls: [{ tool: "create_routine", input: { prompt: `ope681 ${ids} ${randomUUID()}`, trigger: TRIGGER }, id: `${ids}-routine` }] },
        { say: "proposed" },
      ],
    }),
  );

  const wakeCursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  await driveForward(handle, { callId: `${ids}-delegate`, label: ids, cursor: wakeCursor });

  const requested = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(wakeCursor, ["approval.requested"], { limit: 300 })).find((r) => r.detail?.kind === "routine.create"),
    label: `the ${ids} approval.requested row to land`,
    actions: ["approval.requested"],
    cursor: wakeCursor,
    kind: "routine.create",
    timeoutMs: 120_000,
  });
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
  disposeLater(proposal);
  const customId = await customIdFor(id);

  expect(proposal.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  proposal.dispose();

  const wakeCallId = `s1-delegate-${randomUUID()}`;
  const wake: ScriptedHandle = registerScript({
    parent: [{ calls: [{ tool: "work", input: { message: "write ope681.txt and post it here" }, id: wakeCallId }] }, ...RECEIPT_STEP],
    child: [
      {
        delayMs: 120_000,
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
  disposeLater(wake);

  seen.length = 0;
  const clickCursor = await auditCursor();
  const click = postGuildClick(customId);
  await driveForward(wake, { callId: wakeCallId, label: "decision-wake delegation's", cursor: clickCursor });
  const res = await click;
  expect(res.status).toBe(200);
  expect((JSON.parse(res.body) as { type?: number }).type).toBe(7);

  const diverged = (await rowsSinceCursor(clickCursor, ["egress.policy"], { limit: 300 })).filter((r) => r.detail?.reason === "subagent-binding-divergence");
  expect(diverged.map((r) => `${r.platform}/${r.workspace}/${r.surface}`)).toEqual([]);
  expect((await rowsSinceCursor(clickCursor, ["binding.refused"], { limit: 300 })).map((r) => r.detail?.reason)).toEqual([]);

  expect(seen.length).toBe(1);
  expectBoundToTheDispatchingRoom(seen[0]!);
  expect(seen[0]!.principalId).toBe("9000000000000000042");
});

test("🔴 the control: a worker dispatched from an ordinary MENTION-woken turn still binds correctly", async () => {
  await armAgent();

  const controlCallId = `c1-delegate-${randomUUID()}`;
  const dispatched = registerScript({
    parent: [{ calls: [{ tool: "work", input: { message: "write ope681-control.txt and post it here" }, id: controlCallId }] }, ...RECEIPT_STEP],
    child: [
      {
        delayMs: 120_000,
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
  disposeLater(dispatched);

  seen.length = 0;
  const controlCursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> write a file and post it" });
  await driveForward(dispatched, { callId: controlCallId, label: "mention delegation's", cursor: controlCursor });

  expect(seen.length).toBe(1);
  expectBoundToTheDispatchingRoom(seen[0]!);
  expect(seen[0]!.principalId).toBe("9000000000000000042");
});
