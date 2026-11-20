import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { parseWindowToken } from "@open-everywhere/core/agent/channels/window-key.js";
import { unifiedDomainSessionKey } from "@open-everywhere/core/agent/channels/unified-supervisor.js";
import { WORK_ROTATED_ACTION } from "@open-everywhere/core/agent/channels/work-generation.js";

import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackTs,
  waitFor,
  workTaskIdOfCall,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

// A follow-up that starts as a NEW job after the work session rotated: its worker has no earlier
// context, so the forward carries the earlier job's RESULT (what the person already got) into the
// new job's brief. The rotation is real: the operator's rotate mark on the work session's registry
// row, which the next forward reads. The result row is written by the real result wake.

const ROOM = "C0EXFRESR05";
const SLACK_BOT = "U0FRESRBOT1";
const MEMBER = "U0FRESRMEM1";
const OTHER_MEMBER = "U0FRESROTH1";

const OPEN_BRIEF = "fresh-result job: total the quarterly ledger";
const OPEN_RESULT = "fresh-result opening conclusion: the ledger totals 4812 units, and row 17 is a duplicate I removed";
const OTHER_BRIEF = "fresh-result other job: check another sheet";
const OTHER_RESULT = "fresh-result other conclusion: the other sheet is clean";
const FOLLOW_BRIEF = "fresh-result follow-up: now split that total by team";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0FRESRBOT1", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `fresr-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      const channel = params.get("channel");
      return {
        ok: true,
        channel: { id: channel, name: `it-fresr-${String(channel).slice(-3).toLowerCase()}`, is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 28050) };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

/** A signed Slack `app_mention`, with one shared file when `file` is given. */
async function slackMention(
  base: string,
  input: { readonly userId: string; readonly ts: string; readonly text: string; readonly file?: { readonly id: string; readonly name: string; readonly mimetype: string; readonly url: string } },
): Promise<number> {
  const { buildChannelMentionEnvelope, SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../../packages/core/scripts/e2e/synthetic");
  const env = buildChannelMentionEnvelope({
    text: input.text,
    channelId: ROOM,
    userId: input.userId,
    teamId: SLACK_TEAM_ID,
    ts: input.ts,
    eventId: `EvFRESR${input.ts.replace(".", "")}`,
  }) as { event: Record<string, unknown> };
  if (input.file !== undefined) env.event.files = [{ id: input.file.id, name: input.file.name, title: input.file.name, mimetype: input.file.mimetype, url_private: input.file.url }];
  const rawBody = JSON.stringify(env);
  const signed = signSlackRequest(rawBody, process.env.SLACK_SIGNING_SECRET ?? "");
  const res = await fetch(`${base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": signed.timestamp, "x-slack-signature": signed.signature },
    body: rawBody,
    signal: AbortSignal.timeout(120_000),
  });
  return res.status;
}

/** One job, forwarded and settled: the seat forwards, the worker answers, the seat reads the result. */
async function runJob(base: string, input: { readonly tag: string; readonly userId: string; readonly brief: string; readonly result: string; readonly seq: number }): Promise<{ readonly taskId: string; readonly workToken: string; readonly worker: RecordedRequest; readonly seatResult: string }> {
  const cursor = await auditCursor();
  const callId = `fresh-result-${input.tag}`;
  const job = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: input.brief }, id: callId }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ say: input.result }],
    }),
  );
  afterThisTest(() => job.releaseHolds());
  expect(await slackMention(base, { userId: input.userId, ts: slackTs(Date.now(), input.seq), text: `<@${SLACK_BOT}> fresh-result ${input.tag}` })).toBe(200);
  await waitFor(() => job.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${input.tag}: the seat's dispatch turn to serve its last step`);
  const results = disposeLater(armSettlement(job, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const worker = await waitFor(() => job.requests.find((r) => r.role === "child" && r.stepIndex === 0), `${input.tag}: the worker's first model call`);
  const taskId = await workTaskIdOfCall(cursor, job, callId, `${input.tag}: the job's task`);
  const seatTurn = await awaitWorkResult({ handle: results, taskId, label: `${input.tag}: the seat's result turn` });
  const forwarded = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.forwarded"])).find((r) => typeof r.detail?.["workToken"] === "string"), `${input.tag}: the work.forwarded row`);
  for (const [h, label] of [[job, `${input.tag}: the dispatch`], [results, `${input.tag}: the result turn`]] as const) assertNoFault(h, label);
  job.dispose();
  results.dispose();
  return { taskId, workToken: String(forwarded.detail?.["workToken"]), worker, seatResult: promptOf(seatTurn) };
}

test("a follow-up that starts as a NEW job after the work session rotated carries the earlier job's result, and never another job's", async () => {
  armSlack();
  const { base } = await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();

  const opening = await runJob(base, { tag: "open", userId: MEMBER, brief: OPEN_BRIEF, result: OPEN_RESULT, seq: 28051 });
  expect(opening.seatResult, "the seat never got the opening job's result, so the carry below would prove nothing").toContain(OPEN_RESULT);
  const other = await runJob(base, { tag: "other", userId: OTHER_MEMBER, brief: OTHER_BRIEF, result: OTHER_RESULT, seq: 28052 });
  expect(other.seatResult, "the seat never got the other job's result, so the control below would prove nothing").toContain(OTHER_RESULT);
  expect(other.workToken, "the two jobs ran in different work sessions, so the control below would not share a seat").toBe(opening.workToken);

  const wToken = opening.workToken.replace(/^unified:/u, "");
  const wKey = unifiedDomainSessionKey(parseWindowToken(wToken)!.windowId);
  expect((await store.getChannelSession(org, wKey))?.token, "the work session's registry row").toBe(wToken);
  expect(await store.markChannelSessionRotation(org, wKey, new Date().toISOString()), "the operator's rotate mark landed on the work session's row").toBe(true);

  const cursor = await auditCursor();
  const follow = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: FOLLOW_BRIEF, taskId: opening.taskId }, id: "fresh-result-follow" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ say: "fresh-result follow-up result" }],
    }),
  );
  afterThisTest(() => follow.releaseHolds());
  expect(await slackMention(base, { userId: MEMBER, ts: slackTs(Date.now(), 28053), text: `<@${SLACK_BOT}> fresh-result now split that total by team` })).toBe(200);

  // The seat's scripted `work` call carries only FOLLOW_BRIEF, so the earlier result can reach the
  // worker only through the forward's own carry.
  expect(FOLLOW_BRIEF).not.toContain(OPEN_RESULT);
  await waitFor(() => follow.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the seat's follow-up step");
  const rotated = await waitFor(async () => (await rowsSinceCursor(cursor, [WORK_ROTATED_ACTION])).find((r) => r.detail?.["from"] === wToken), "the work.session_rotated row");
  expect(rotated.detail?.["trigger"]).toBe("operator-marked");
  const forwarded = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.forwarded"])).at(0), "the follow-up's work.forwarded row");
  expect(forwarded.detail?.["continuation"], "the follow-up did not start as a NEW job, so this spec does not exercise the fresh path").toBe("fresh-idle");
  expect(forwarded.detail?.["workToken"]).not.toBe(opening.workToken);
  await waitFor(() => follow.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's follow-up turn to serve its last step");
  const results = disposeLater(armSettlement(follow, { parent: [{ say: NO_REPLY_SENTINEL }] }));

  const worker = await waitFor(() => follow.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the fresh job's worker's first model call");
  expect(worker.sessionId, "the fresh job's worker is the opening job's worker, so no rotation happened").not.toBe(opening.worker.sessionId);
  const brief = promptOf(worker);
  expect(brief, "the fresh job's worker never read the follow-up").toContain(FOLLOW_BRIEF);
  expect(brief, "…nor the earlier job's brief").toContain(OPEN_BRIEF);
  expect(brief, "🔴 the earlier job's result did not reach the fresh job's worker").toContain(`> ${OPEN_RESULT}`);
  expect(brief, "🔴 …with its settled status").toContain("The earlier job's result (it completed)");
  expect(brief, "🔴 the brief still tells the worker it lacks the earlier job's work, beside a result it holds").not.toContain("you do not have the earlier job's work");
  expect(brief, "🔴 NEGATIVE CONTROL: another task's result in the same seat reached this job's worker").not.toContain(OTHER_RESULT);

  const taskId = await workTaskIdOfCall(cursor, follow, "fresh-result-follow", "the fresh job's task");
  expect(taskId, "the fresh job reused the earlier task").not.toBe(opening.taskId);
  await awaitWorkResult({ handle: results, taskId, label: "the seat's result turn for the fresh job" });
  for (const [h, label] of [[follow, "the follow-up"], [results, "the follow-up's result turn"]] as const) assertNoFault(h, label);
}, 600_000);
