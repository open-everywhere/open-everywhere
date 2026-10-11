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
  runScheduleTask,
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
const TENANT = "11111111-2222-3333-4444-555555555555";
const ORGANISER = "3a1e1c5e-0000-4000-8000-00000000a001";
const TEAMS_LINK = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_it%40thread.v2/0?context=${encodeURIComponent(JSON.stringify({ Tid: TENANT, Oid: ORGANISER }))}`;
const SECRET_REF = "IT_TEAMS_TRANSCRIPT_SECRET";
process.env[SECRET_REF] = "it-teams-client-secret";

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

async function askForRecap(ids: string): Promise<{ cursor: AuditCursor; handle: ScriptedHandle }> {
  const handle: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "work", input: { message: `recap this meeting ${TEAMS_LINK} (${ids})` }, id: `${ids}-delegate` }] },
      { say: NO_REPLY_SENTINEL },
    ],
    child: [
      { delayMs: 120_000, calls: [{ tool: "meeting_recap", input: { url: TEAMS_LINK, when: "next", reason: `weekly sync ${ids}` }, id: `${ids}-recap` }] },
      { say: "asked" },
    ],
  });
  disposeLater(handle);
  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> recap ${TEAMS_LINK} ${ids}` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `the ${ids} receipt step`);
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, `${ids}-delegate`, `${ids} forward receipt`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's terminal step` });
  await awaitWorkResult({ handle: settlement, taskId, label: `the ${ids} seat step that read the worker's result` });
  settlement.dispose();
  return { cursor, handle };
}

function recapResultText(handle: ScriptedHandle): string {
  const step = handle.requests.find((r) => r.role === "child" && r.stepIndex === 1);
  return JSON.stringify(step ?? {});
}

async function askAndApprove(ids: string): Promise<{ recapId: string; clickCursor: AuditCursor }> {
  const { cursor, handle } = await askForRecap(ids);
  handle.dispose();
  const requested = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(cursor, ["approval.requested"])).find((r) => r.detail?.kind === "meeting.recap"),
    label: `the ${ids} meeting.recap approval.requested row`,
    actions: ["approval.requested"],
    cursor,
    kind: "meeting.recap",
    timeoutMs: 60_000,
  });
  const s = await getStore();
  const row = await s.getPendingAction(org, requested.detail?.id as string);
  expect(row?.status).toBe("pending");
  const frozen = JSON.parse(row!.argsJson) as { recapId: string; url: string; organizerId: string; tenantId: string; when: string };
  expect(frozen.url).toBe(TEAMS_LINK);
  expect(frozen.organizerId).toBe(ORGANISER);
  expect(frozen.when).toBe("next");
  const { buildDiscordApprovalCustomId } = await import("@open-everywhere/provider-discord/agent/approvals/discord-card.js");
  const clickCursor = await auditCursor();
  const click = await postClick(buildDiscordApprovalCustomId(row!, "approve"));
  expect(click.status).toBe(200);
  return { recapId: frozen.recapId, clickCursor };
}

const POLICY_MODULE = "@open-everywhere/core/agent/meetings/policy.js";
const NATIVE_MODULE = "@open-everywhere/core/agent/meetings/native.js";

test("⓪ with the shipped policy (native recaps off) the tool refuses before any card", async () => {
  ({ base } = await bootAgent({ sharedSqlite: true }));
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: "off" } });
  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  org = binding.deploymentOrg();

  const policy = await import(POLICY_MODULE);
  expect(policy.meetingPolicy().native.enabled, "the app's shipped agent/meetings/policy.ts keeps native recaps off").toBe(false);
  const nativeMod = await import(NATIVE_MODULE);
  expect(nativeMod.nativeTranscriptSource("teams")?.platform, "the boot registered the real Teams reader").toBe("teams");
  const { cursor, handle } = await askForRecap("n0");
  expect(recapResultText(handle)).toContain("are not enabled on this deployment");
  const requested = await rowsSinceCursor(cursor, ["approval.requested"]);
  expect(requested.filter((r) => r.detail?.kind === "meeting.recap")).toEqual([]);
});

test("①②③ an approved meeting_recap waits for the platform's transcript, the compiled sweep posts ONE recap, and a refusal is said in the thread", async () => {
  const policyMod = await import(POLICY_MODULE);
  policyMod.setMeetingPolicyForTest({
    ...policyMod.DEFAULT_MEETING_POLICY,
    native: { enabled: true, watchHours: 6, teams: { tenants: [TENANT], clientId: "0f0f0f0f-1111-2222-3333-444444444444", clientSecretRef: SECRET_REF, why: "integration test" } },
  });
  cleanups.push(() => policyMod.resetMeetingPolicyForTest());

  const nativeMod = await import(NATIVE_MODULE);
  const realTeams = nativeMod.nativeTranscriptSource("teams");
  cleanups.push(() => realTeams !== undefined && nativeMod.registerNativeTranscriptSource(realTeams));
  let answer: unknown = { status: "pending" };
  const reads: { organizerId?: string; startedAfter?: number; secret: string }[] = [];
  nativeMod.registerNativeTranscriptSource({
    platform: "teams",
    disclosure: "a fake Teams reader for the integration tier",
    async read(ref: { organizerId?: string; startedAfter?: number }, ctx: { policy: { teams?: { clientSecretRef: string } }; secret: (n: string) => Promise<string> }) {
      reads.push({ ...(ref.organizerId !== undefined ? { organizerId: ref.organizerId } : {}), ...(ref.startedAfter !== undefined ? { startedAfter: ref.startedAfter } : {}), secret: await ctx.secret(ctx.policy.teams!.clientSecretRef) });
      return answer;
    },
  });

  const tx = await import("@open-everywhere/core/agent/meetings/transcription.js");
  const prompts: string[] = [];
  tx.registerMeetingCompletion(async (_scope: string, prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ summary: "The team set the launch date.", decisions: ["Launch on 2 November"], actions: [{ owner: "Ben Okafor", item: "Book the venue" }] });
  });
  cleanups.push(() => tx.resetMeetingCompletionForTest());

  const one = await askAndApprove("n1");
  const requestedRow = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(one.clickCursor, ["meeting.recap_requested"])).find((r) => r.detail?.meetingId === one.recapId),
    label: "the meeting.recap_requested row",
    actions: ["meeting.recap_requested"],
    cursor: one.clickCursor,
    timeoutMs: 60_000,
  });
  expect(requestedRow.principalId).toBe(CLICKER_ID);
  expect(requestedRow.detail?.platform).toBe("teams");
  expect(reads.length).toBe(1);
  expect(reads[0]!.organizerId).toBe(ORGANISER);
  expect(reads[0]!.secret, "core resolved the org's secret by the name the policy declares").toBe("it-teams-client-secret");
  expect(typeof reads[0]!.startedAfter, "a `next` ask reads only a later session").toBe("number");
  const flow = await import("@open-everywhere/core/agent/meetings/native-recap.js");
  expect((await flow.nativeWatches(org)).map((w: { recapId: string }) => w.recapId)).toContain(one.recapId);
  expect(await rowsSinceCursor(one.clickCursor, ["meeting.recap_posted"])).toEqual([]);

  answer = {
    status: "ready",
    startedAt: "2026-01-15T16:00:00Z",
    endedAt: "2026-01-15T16:31:40Z",
    segments: [
      { speaker: "Ana Lopez", text: "We agreed the launch date is 2 November.", startMs: 1000 },
      { speaker: "Ben Okafor", text: "I will book the venue.", startMs: 6000 },
    ],
  };
  const sweepCursor = await auditCursor();
  await runScheduleTask("schedules/meeting-sweep.ts");
  const posted = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(sweepCursor, ["meeting.recap_posted"])).find((r) => r.detail?.meetingId === one.recapId),
    label: "the meeting.recap_posted row",
    actions: ["meeting.recap_posted"],
    cursor: sweepCursor,
    timeoutMs: 60_000,
  });
  expect(posted.detail?.posted).toBe(true);
  expect(posted.detail?.source).toBe("native");
  expect(posted.detail?.speakers).toBe(2);
  expect(posted.detail?.decisions).toBe(1);
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("untrusted_external_data");
  expect(prompts[0]).toContain("[Ben Okafor] I will book the venue.");
  expect((await flow.nativeWatches(org)).map((w: { recapId: string }) => w.recapId)).not.toContain(one.recapId);
  await runScheduleTask("schedules/meeting-sweep.ts");
  expect((await rowsSinceCursor(sweepCursor, ["meeting.recap_posted"])).filter((r) => r.detail?.meetingId === one.recapId).length, "a later sweep posts nothing twice").toBe(1);

  answer = { status: "refused", reason: "access-off", hint: "Grant the app the transcript permission." };
  const three = await askAndApprove("n3");
  const refused = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(three.clickCursor, ["meeting.recap_refused"])).find((r) => r.detail?.meetingId === three.recapId),
    label: "the meeting.recap_refused row",
    actions: ["meeting.recap_refused"],
    cursor: three.clickCursor,
    timeoutMs: 60_000,
  });
  expect(refused.detail?.reason).toBe("access-off");
  expect(refused.detail?.posted, "the refusal went into the thread").toBe(true);
});
