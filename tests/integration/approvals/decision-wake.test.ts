// proves: approval.decision_wake

import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
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
  type AuditCursor,
  type ScriptedHandle,
} from "../harness";

delete process.env.DISCORD_BOT_TOKEN;

const TRUSTED = generateKeyPairSync("ed25519");
function publicKeyHex(pair: { publicKey: KeyObject }): string {
  return Buffer.from((pair.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
}
const TRUSTED_PUBLIC_KEY_HEX = publicKeyHex(TRUSTED);

const DISCORD_INTERACTIONS_ROUTE = "/eve/v1/discord";

const CLICKER_ID = "9000000000000000079";

const WINDOW_DOMAIN = "e2e-unified";

let base = "";
let org = "";

async function armAgent(): Promise<void> {
  ({ base } = await bootAgent({ sharedSqlite: true, settings: { discord: { publicKey: TRUSTED_PUBLIC_KEY_HEX } } }));
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

async function proposeRoutine(ids: string, prompt: string): Promise<{ id: string; handle: ScriptedHandle; taskId: string }> {
  const handle: ScriptedHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [
        { delayMs: 120_000, calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: `${ids}-routine` }] },
        { say: "proposed" },
      ],
    }),
  );

  const wakeCursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  const receiptStep = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    `the ${ids} receipt step to be served`,
  );
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(wakeCursor, handle, `${ids}-delegate`, `the ${ids} delegation`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's own terminal step` });
  expect(handle.holdsCutShort(), "the worker's hold ended on the release, not on its 120 s backstop").toBe(1);
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `the ${ids} seat step that read the worker's result` });
  expect(resultStep.stepIndex).toBe(0);
  expect(typeof receiptStep.turnId, "the recorder stamps eve's turn id").toBe("string");
  expect(resultStep.turnId, "the result arrives in a seat turn of its own, never the proposal turn").not.toBe(receiptStep.turnId);
  for (const h of [handle, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }
  settlement.dispose();

  const requested = await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(wakeCursor, ["approval.requested"]);
      return rows.find((r) => r.detail?.kind === "routine.create");
    },
    label: "this turn's approval.requested row to land",
    actions: ["approval.requested"],
    cursor: wakeCursor,
    kind: "routine.create",
    timeoutMs: 60_000,
  });
  const id = requested.detail?.id;
  expect(typeof id).toBe("string");
  return { id: id as string, handle, taskId };
}

async function waitForDecided(clickCursor: AuditCursor, id: string): Promise<void> {
  await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(clickCursor, ["approval.approved", "approval.failed", "approval.rejected"]);
      return rows.find((r) => r.detail?.id === id);
    },
    label: `a terminal approval row for pending ${id}`,
    actions: ["approval.approved", "approval.failed", "approval.rejected"],
    cursor: clickCursor,
    timeoutMs: 60_000,
  });
}

test("🔴 the control: a click with NO guild_id decides the card and writes NO approval.decision_wake row", async () => {
  await armAgent();
  const { id, handle } = await proposeRoutine("w1", `decision wake control (w1) ${randomUUID()}`);
  disposeLater(handle);

  const clickCursor = await auditCursor();
  const res = await postClick({ customId: await customIdFor(id, "approve") });
  expect(res.status).toBe(200);
  await waitForDecided(clickCursor, id);

  await new Promise((r) => setTimeout(r, 1_000));
  const wakes = await rowsSinceCursor(clickCursor, ["approval.decision_wake"]);
  expect(wakes.filter((r) => r.detail?.id === id).map((r) => r.action)).toEqual([]);

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("approved");

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

test("a guild-context click wakes the proposing window session with the decision, and audits the delivery", async () => {
  await armAgent();
  const { id, handle: proposal, taskId: workerTaskId } = await proposeRoutine("w2", `decision wake subject (w2) ${randomUUID()}`);
  disposeLater(proposal);
  const customId = await customIdFor(id, "approve");

  expect(proposal.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  proposal.dispose();

  const brakeCallId = `w2-brake-${randomUUID()}`;
  const wake: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "cancel_work", input: { taskId: workerTaskId }, id: brakeCallId }] },
      { calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: `w2-silent-${randomUUID()}` }] },
      { say: "belief updated" },
    ],
  });
  disposeLater(wake);

  const clickCursor = await auditCursor();
  const res = await postClick({ customId, guildId: DISCORD_GUILD_ID });
  expect(res.status).toBe(200);
  expect((JSON.parse(res.body) as { type?: number }).type).toBe(7);
  await waitForDecided(clickCursor, id);

  const served = await waitFor(() => wake.requests.find((r) => r.role === "parent"), "the wake turn to reach the scripted model", 120_000);
  expect(served.stepIndex).toBe(0);
  expect(wake.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(wake.resolves.filter((r) => r.fault !== undefined)).toEqual([]);

  const row = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(clickCursor, ["approval.decision_wake"])).find((r) => r.detail?.id === id),
    label: `an approval.decision_wake row for pending ${id}`,
    actions: ["approval.decision_wake"],
    cursor: clickCursor,
    timeoutMs: 60_000,
  });
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

  const brakeStep = await waitFor(
    () => wake.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.id === brakeCallId)),
    "the wake turn's cancel_work result",
  );
  const brake = brakeStep.toolResults.find((t) => t.id === brakeCallId)!;
  const brakeText = JSON.stringify(brake.output);
  expect(brake.isError, `the brake's cancel_work was refused: ${brakeText}`).toBe(false);
  expect(brakeText).not.toContain("cannot be continued here");
  expect(brakeText).toContain(workerTaskId);
  const relayed = await waitFor(
    async () => (await rowsSinceCursor(clickCursor, ["work.cancel_relayed"])).find((r) => r.detail?.taskId === workerTaskId),
    "the work.cancel_relayed row for the braked task",
  );
  expect(relayed.detail?.outcome, "the seat's stop was refused under D10").toBe("relayed");
  const ticketKey = `oe-work-cancel:${String(relayed.detail?.workToken)}:${workerTaskId}`;
  await waitFor(async () => {
    const raw = await (await getStore()).getTaskResult(org, ticketKey);
    return raw !== null && (JSON.parse(raw) as { spent?: unknown }).spent === true ? true : undefined;
  }, "the work session's task_cancel to redeem the seat's cancel ticket");
  await waitFor(
    async () => ((await rowsSinceCursor(clickCursor, ["work.cancel_redeemed"])).some((r) => r.detail?.taskId === workerTaskId && r.detail?.outcome === "admitted") ? true : undefined),
    "the work session's fenced task_cancel to be ADMITTED for the braked task",
  );
  await awaitWindowQuiet();
  const forTask = (await rowsSinceCursor(clickCursor, ["work.cancel_redeemed"])).filter((r) => r.detail?.taskId === workerTaskId);
  expect(forTask.map((r) => r.detail?.outcome), "the work session's task_cancel was REFUSED by the fence on some validation").not.toContain("refused");
  expect(prompt).toContain(`<system-note>A pending approval you were waiting on (id ${id})`);
  expect(prompt).not.toContain(`approval-decision-${id}`);
});
