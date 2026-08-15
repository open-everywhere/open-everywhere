import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterEach, expect, test } from "vitest";

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

const WINDOW_DOMAIN = "e2e-unified";

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

let base = "";
let org = "";

async function armAgent(): Promise<void> {
  ({ base } = await bootAgent({ sharedSqlite: true }));
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: "off" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("off");
  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  org = binding.deploymentOrg();
}

async function getStore() {
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  return provider.getOperationalStore();
}

async function postClick(input: {
  readonly customId: string;
  readonly guildId?: string;
  readonly timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  const user = { id: CLICKER_ID };
  const body = JSON.stringify({
    type: 3,
    id: randomUUID(),
    application_id: "9000000000000000001",
    channel_id: DISCORD_LISTED_CHANNEL_ID,
    data: { custom_id: input.customId, component_type: 2 },
    ...(input.guildId
      ?
        { guild_id: input.guildId, member: { user, permissions: "0" } }
      : { user }),
    token: `it-${randomUUID()}`,
    version: 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), TRUSTED.privateKey).toString("hex");
  const res = await fetch(`${base}${DISCORD_INTERACTIONS_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? 180_000),
  });
  return { status: res.status, body: await res.text() };
}

async function customIdFor(rowId: string, decision: "approve" | "reject"): Promise<string> {
  const s = await getStore();
  const row = await s.getPendingAction(org, rowId);
  expect(row).not.toBeNull();
  const { buildDiscordApprovalCustomId } = await import("@open-everywhere/provider-discord/agent/approvals/discord-card.js");
  return buildDiscordApprovalCustomId(row!, decision);
}

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;

async function proposeRoutine(ids: string, prompt: string): Promise<{ id: string; handle: ScriptedHandle }> {
  const handle: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "agent", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
      { say: "the worker reported back" },
    ],
    child: [
      { calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: `${ids}-routine` }] },
      { say: "proposed" },
    ],
  });

  const wakeAt = Date.now();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's own terminal step` });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, `the ${ids} delegation`),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: `the ${ids} worker's settlement wake`,
  });
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  drained.handle.dispose();

  const requested = await waitFor(
    async () => {
      const rows = await rowsSince(wakeAt, ["approval.requested"]);
      return rows.find((r) => r.detail?.kind === "routine.create");
    },
    "this turn's approval.requested row to land",
    60_000,
  );
  const id = requested.detail?.id;
  expect(typeof id).toBe("string");
  return { id: id as string, handle };
}

async function rowsSince(since: number, actions: readonly string[]): Promise<AuditRow[]> {
  const got = await readAuditRows({ actions, sinceIso: new Date(since - 1_000).toISOString(), limit: 200 });
  return got.filter((r) => new Date(r.ts).getTime() >= since);
}

async function waitForDecided(clickAt: number, id: string): Promise<void> {
  await waitFor(
    async () => {
      const rows = await rowsSince(clickAt, ["approval.approved", "approval.failed", "approval.rejected"]);
      return rows.find((r) => r.detail?.id === id);
    },
    `a terminal approval row for pending ${id}`,
    60_000,
  );
}

test("🔴 the control: a click with NO guild_id decides the card and writes NO approval.decision_wake row", async () => {
  await armAgent();
  const { id, handle } = await proposeRoutine("w1", `decision wake control (w1) ${randomUUID()}`);
  perTest.push(() => handle.dispose());

  const clickAt = Date.now();
  const res = await postClick({ customId: await customIdFor(id, "approve") });
  expect(res.status).toBe(200);
  await waitForDecided(clickAt, id);

  await new Promise((r) => setTimeout(r, 1_000));
  const wakes = await rowsSince(clickAt, ["approval.decision_wake"]);
  expect(wakes.filter((r) => r.detail?.id === id).map((r) => r.action)).toEqual([]);

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("approved");
});

test("a guild-context click wakes the proposing window session with the decision, and audits the delivery", async () => {
  await armAgent();
  const { id, handle: proposal } = await proposeRoutine("w2", `decision wake subject (w2) ${randomUUID()}`);
  perTest.push(() => proposal.dispose());
  const customId = await customIdFor(id, "approve");

  expect(proposal.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  proposal.dispose();

  const wake: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: `w2-silent-${randomUUID()}` }] },
      { say: "belief updated" },
    ],
  });
  perTest.push(() => wake.dispose());

  const clickAt = Date.now();
  const res = await postClick({ customId, guildId: DISCORD_GUILD_ID });
  expect(res.status).toBe(200);
  expect((JSON.parse(res.body) as { type?: number }).type).toBe(7);
  await waitForDecided(clickAt, id);

  const served = await waitFor(() => wake.requests.find((r) => r.role === "parent"), "the wake turn to reach the scripted model", 120_000);
  expect(served.stepIndex).toBe(0);
  expect(wake.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(wake.resolves.filter((r) => r.fault !== undefined)).toEqual([]);

  const row = await waitFor(
    async () => (await rowsSince(clickAt, ["approval.decision_wake"])).find((r) => r.detail?.id === id),
    `an approval.decision_wake row for pending ${id}`,
    60_000,
  );
  expect(row.detail?.delivered).toBe(true);
  expect(row.detail?.outcome).toBe("approved");
  expect(row.detail?.domain).toBe(WINDOW_DOMAIN);
  expect(row.detail?.kind).toBe("routine.create");
  expect(row.principalId).toBe(CLICKER_ID);

  const wakeId = row.detail?.wakeId;
  expect(typeof wakeId).toBe("string");
  expect((wakeId as string).length).toBeGreaterThan(0);
  const prompt = served.messages.map((m) => m.text).join("\n");
  expect(prompt).toContain(wakeId as string);
  expect(prompt).toContain(id);
});
