import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
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
  slackMentionWake,
  slackTs,
  waitFor,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2613SBOT";
const MEMBER = "U0OPE2613SAA";
const CHILD_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;
const QUIET_WATCH_MS = 5_000;

const BRIEF = "ope2613 job: create a one-shot routine that reminds this channel at 9";
const PENDING = "ope2613 result: the routine is pending human approval and is not armed yet.";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2613SBOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2613-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2613", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 26130) };
    if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

const W_REPEATS = [1, 2, 3, 4].map((n) => ({ calls: [{ tool: "agent", input: { message: BRIEF }, id: `ope2613-w-agent-${n}` }] }));

test("🔴 a job whose worker answers 'pending approval' starts ONCE and wakes the seat ONCE, and the host ends the work session's turn", async () => {
  armSlack();
  await bootAgent();
  const cursor = await auditCursor();

  const dispatch = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: BRIEF }, id: "ope2613-work" }] }, { say: NO_REPLY_SENTINEL }],
      work: [...W_REPEATS, { say: "ope2613 W done" }],
      child: [{ delayMs: CHILD_HOLD_MS, say: PENDING }],
    }),
  );
  afterThisTest(() => dispatch.releaseHolds());

  const ts = slackTs(Date.now(), 26131);
  const res = await slackMentionWake({ channelId: SLACK_CHANNEL, userId: MEMBER, text: `<@${SLACK_BOT}> ope2613 set me a reminder routine`, ts, eventId: `EvOPE2613S${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the wake: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => dispatch.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's dispatch turn to serve its last step", TURN_END_CEILING_MS);
  const forwarded = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 50 });
    return rows.length > 0 ? rows : undefined;
  }, "the seat's work.forwarded row");
  expect(forwarded, "one forward, from the seat").toHaveLength(1);
  const requestId = String(detailOf(forwarded[0]).requestId);
  const firstStart = await waitFor(async () => (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 50 })).find((r) => detailOf(r).request === requestId), "the job's first delegation.task_started row");
  const taskId = String(detailOf(firstStart).task);
  await waitFor(() => dispatch.requests.find((r) => r.role === "child" && promptOf(r).includes(BRIEF)), "the worker's first (held) model call");

  const results = disposeLater(armSettlement(dispatch, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  dispatch.releaseHolds();

  const read = await awaitWorkResult({ handle: results, taskId, label: "the seat's result turn" });
  expect(promptOf(read), "the seat's result turn did not carry the worker's answer").toContain(PENDING);

  dispatch.releaseHolds();
  await new Promise((resolve) => setTimeout(resolve, QUIET_WATCH_MS));
  const starts = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 100 })).filter((r) => detailOf(r).request === requestId);
  expect(starts.map((r) => detailOf(r).task), "🔴 the work session started the job more than once (OPE-2613)").toEqual([taskId]);
  const wakes = (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 100 })).filter((r) => detailOf(r).requestId === requestId);
  expect(wakes.map((r) => [detailOf(r).taskId, detailOf(r).outcome]), "🔴 the job woke the seat more than once (OPE-2613)").toEqual([[taskId, "delivered"]]);

  const ended = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.step_boundary"], { limit: 50 });
    return rows.find((r) => detailOf(r).tier === "settled" && detailOf(r).sessionId === detailOf(firstStart).session);
  }, "the turn.step_boundary row with tier settled on W's session", TURN_END_CEILING_MS);
  expect(detailOf(ended).turnId, "the settled row names no turn").toEqual(expect.stringMatching(/.+/));

  expect(dispatch.requests.filter((r) => r.role === "work").map((r) => r.stepIndex), "🔴 W's model was asked again after the job started").toEqual([0]);
  for (const [h, label] of [[dispatch, "the dispatch entry"], [results, "the result turn"]] as const) assertNoFault(h, label);
});
