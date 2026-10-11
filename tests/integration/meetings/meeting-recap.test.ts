import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type ScriptedHandle,
} from "../harness";

for (const k of ["DISCORD_BOT_TOKEN"]) delete process.env[k];

const TRUSTED = generateKeyPairSync("ed25519");
function publicKeyHex(pair: { publicKey: KeyObject }): string {
  return Buffer.from((pair.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
}
process.env.DISCORD_PUBLIC_KEY = publicKeyHex(TRUSTED);
const DISCORD_INTERACTIONS_ROUTE = "/eve/v1/discord";
const CLICKER_ID = "9000000000000000077";
const MEET_LINK = "https://meet.google.com/abc-defg-hij";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

let base = "";
let org = "";

async function getStore() {
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  return provider.getOperationalStore();
}

async function postClick(customId: string): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    type: 3,
    id: randomUUID(),
    application_id: "9000000000000000001",
    channel_id: DISCORD_LISTED_CHANNEL_ID,
    data: { custom_id: customId, component_type: 2 },
    user: { id: CLICKER_ID },
    token: `it-${randomUUID()}`,
    version: 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), TRUSTED.privateKey).toString("hex");
  const res = await fetch(`${base}${DISCORD_INTERACTIONS_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    body,
  });
  return { status: res.status, body: await res.text() };
}

async function askToJoin(ids: string): Promise<{ cursor: AuditCursor; handle: ScriptedHandle }> {
  const handle: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "work", input: { message: `join this meeting ${MEET_LINK} (${ids})` }, id: `${ids}-delegate` }] },
      { say: NO_REPLY_SENTINEL },
    ],
    child: [
      { delayMs: 120_000, calls: [{ tool: "meeting_join", input: { url: MEET_LINK, reason: `weekly sync ${ids}` }, id: `${ids}-join` }] },
      { say: "asked" },
    ],
  });
  disposeLater(handle);
  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> join ${MEET_LINK} ${ids}` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `the ${ids} receipt step`);
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, `${ids}-delegate`, `${ids} forward receipt`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's terminal step` });
  await awaitWorkResult({ handle: settlement, taskId, label: `the ${ids} seat step that read the worker's result` });
  settlement.dispose();
  return { cursor, handle };
}

function joinResultText(handle: ScriptedHandle): string {
  const step = handle.requests.find((r) => r.role === "child" && r.stepIndex === 1);
  return JSON.stringify(step ?? {});
}

const POLICY_MODULE = "@open-everywhere/core/agent/meetings/policy.js";

test("⓪ with the shipped policy (meetings off) the tool refuses before any card", async () => {
  ({ base } = await bootAgent({ sharedSqlite: true }));
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: "off" } });
  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  org = binding.deploymentOrg();
  process.env.OE_PUBLIC_BASE_URL = base;
  cleanups.push(() => delete process.env.OE_PUBLIC_BASE_URL);

  const policy = await import(POLICY_MODULE);
  expect(policy.meetingPolicy().enabled, "the app's shipped agent/meetings/policy.ts keeps meetings off").toBe(false);
  const { cursor, handle } = await askToJoin("m0");
  expect(joinResultText(handle)).toContain("meetings are not enabled");
  const requested = await rowsSinceCursor(cursor, ["approval.requested"]);
  expect(requested.filter((r) => r.detail?.kind === "meeting.join")).toEqual([]);
});

test("①② an approved meeting_join opens a box, and the bot's signed callbacks end in ONE recap in the thread and ONE hours row", async () => {
  const policyMod = await import(POLICY_MODULE);
  policyMod.setMeetingPolicyForTest({
    ...policyMod.DEFAULT_MEETING_POLICY,
    enabled: true,
    hosts: [{ platform: "meet", host: "meet.google.com", owner: "unverifiable", why: "integration test" }],
    transcription: { route: "gateway", model: "test/stt" },
  });
  cleanups.push(() => policyMod.resetMeetingPolicyForTest());

  const boxMod = await import("@open-everywhere/core/agent/sandbox/long-lived-box.js");
  const opened: { purpose: string; ref: string; maxMinutes: number; env: Record<string, string> }[] = [];
  const stopped: string[] = [];
  boxMod.registerLongLivedBoxBackend({
    backend: "fake",
    metered: true,
    maxMinutesCeiling: 1440,
    async open(spec) {
      opened.push({ purpose: spec.purpose, ref: spec.ref, maxMinutes: spec.maxMinutes, env: { ...spec.env } });
      return { name: `fake-box-${opened.length}`, backend: "fake", createdAt: Date.now() - 45 * 60_000, maxMinutes: spec.maxMinutes };
    },
    async status() {
      return undefined;
    },
    async list() {
      return [];
    },
    async stop(name) {
      stopped.push(name);
    },
  });
  cleanups.push(() => boxMod.resetLongLivedBoxBackendForTest());

  const tx = await import("@open-everywhere/core/agent/meetings/transcription.js");
  const prompts: string[] = [];
  tx.registerMeetingCompletion(async (_scope: string, prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ summary: "The team agreed the launch date.", decisions: ["Launch on 2 November"], actions: [{ owner: "Ana", item: "Book the venue" }] });
  });
  cleanups.push(() => tx.resetMeetingCompletionForTest());
  const realGateway = tx.transcriptionRoute("gateway");
  const sttPrompts: (string | undefined)[] = [];
  const sttAnswers = [
    { text: "We launch on the second of November. I can book the", segments: [{ text: "We launch on the second of November.", startSecond: 0, endSecond: 3 }, { text: "I can book the", startSecond: 50, endSecond: 52 }] },
    { text: "venue. Good, thanks.", segments: [{ text: "venue.", startSecond: 0, endSecond: 1 }, { text: "Good, thanks.", startSecond: 4, endSecond: 6 }] },
  ];
  tx.registerTranscriptionRoute({
    id: "gateway",
    disclosure: "integration test",
    async transcribe(input: { kind: string }, opts: { prompt?: string }) {
      expect(input.kind).toBe("audio");
      sttPrompts.push(opts.prompt);
      return sttAnswers[sttPrompts.length - 1]!;
    },
  });
  cleanups.push(() => {
    if (realGateway !== undefined) tx.registerTranscriptionRoute(realGateway);
  });

  const { cursor } = await askToJoin("m1");
  const requested = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(cursor, ["approval.requested"])).find((r) => r.detail?.kind === "meeting.join"),
    label: "the meeting.join approval.requested row",
    actions: ["approval.requested"],
    cursor,
    kind: "meeting.join",
    timeoutMs: 60_000,
  });
  const pendingId = requested.detail?.id as string;
  const s = await getStore();
  const row = await s.getPendingAction(org, pendingId);
  expect(row?.status).toBe("pending");
  expect(opened, "nothing joins before the click").toEqual([]);
  const frozen = JSON.parse(row!.argsJson) as { meetingId: string; url: string; host: string };
  expect(frozen.url).toBe(MEET_LINK);
  const { buildDiscordApprovalCustomId } = await import("@open-everywhere/provider-discord/agent/approvals/discord-card.js");
  const clickCursor = await auditCursor();
  const click = await postClick(buildDiscordApprovalCustomId(row!, "approve"));
  expect(click.status).toBe(200);
  const joinRow = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(clickCursor, ["meeting.join"])).find((r) => r.detail?.meetingId === frozen.meetingId),
    label: "the meeting.join row",
    actions: ["meeting.join"],
    cursor: clickCursor,
    timeoutMs: 60_000,
  });
  expect(joinRow.principalId).toBe(CLICKER_ID);
  expect(opened.length).toBe(1);
  expect(opened[0]!.purpose).toBe("meeting");
  expect(opened[0]!.ref).toBe(frozen.meetingId);
  expect(opened[0]!.env.OE_MEETING_CALLBACK).toBe(`${base}/meetings/v1/${frozen.meetingId}`);

  const storeMod = await import("@open-everywhere/core/agent/meetings/store.js");
  const rec = await storeMod.getMeetingRecord(org, frozen.meetingId);
  expect(rec?.status).toBe("joining");
  const { standardWebhookSignature } = await import("@open-everywhere/core/agent/webhooks/oe-standard-webhook.js");
  let n = 0;
  async function callback(body: unknown, signed = true): Promise<number> {
    const raw = JSON.stringify(body);
    const id = `msg_it_${++n}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signed) {
      headers["webhook-id"] = id;
      headers["webhook-timestamp"] = ts;
      headers["webhook-signature"] = standardWebhookSignature(rec!.secret, id, ts, raw);
    }
    const res = await fetch(`${base}/meetings/v1/${frozen.meetingId}`, { method: "POST", headers, body: raw });
    return res.status;
  }
  expect(await callback({ type: "status", state: "admitted" }, false), "an unsigned callback is refused").toBe(401);
  const endCursor = await auditCursor();
  expect(await callback({ type: "status", state: "admitted" })).toBe(200);
  const audio = { mediaType: "audio/webm", base64: "AAAA" };
  expect(await callback({ type: "chunk", seq: 0, audio, speakers: [{ name: "Ana", startMs: 0, endMs: 3_200 }, { name: "Ben", startMs: 49_800, endMs: 53_000 }], attendees: ["Ana", "Ben"] })).toBe(200);
  expect(await callback({ type: "chunk", seq: 1, audio, speakers: [{ name: "Ben", startMs: 0, endMs: 1_300 }, { name: "Ana", startMs: 3_800, endMs: 6_500 }], attendees: ["Ana", "Ben"] })).toBe(200);
  expect(sttPrompts).toEqual(["Attendees: Ana, Ben.", "Attendees: Ana, Ben.\nWe launch on the second of November. I can book the"]);
  expect(await callback({ type: "ended", chunks: 2, reason: "meeting-ended" })).toBe(200);

  const recapRow = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(endCursor, ["meeting.recap_posted"])).find((r) => r.detail?.meetingId === frozen.meetingId),
    label: "the meeting.recap_posted row",
    actions: ["meeting.recap_posted"],
    cursor: endCursor,
    timeoutMs: 60_000,
  });
  expect(recapRow.detail?.posted).toBe(true);
  expect(recapRow.detail?.decisions).toBe(1);
  expect(recapRow.detail?.actions).toBe(1);
  expect(stopped).toEqual(["fake-box-1"]);
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("untrusted_external_data");
  expect(prompts[0]).toContain("[Ana] We launch on the second of November.\n[Ben] I can book the\n[Ben] venue.\n[Ana] Good, thanks.");
  expect(recapRow.detail?.labelledLines).toBe(4);
  const usage = await s.usageForSession(org, `meeting:${frozen.meetingId}`);
  expect(usage.map((u) => u.kind)).toEqual(["meeting"]);
  expect(Number(usage[0]!.detail?.meetingSeconds)).toBeGreaterThan(40 * 60);
  const status = await rowsSinceCursor(endCursor, ["meeting.status"]);
  expect(status.filter((r) => r.detail?.meetingId === frozen.meetingId).map((r) => r.detail?.state)).toEqual(["admitted"]);
  const ended = await rowsSinceCursor(endCursor, ["meeting.ended"]);
  expect(ended.filter((r) => r.detail?.meetingId === frozen.meetingId).length).toBe(1);
});
