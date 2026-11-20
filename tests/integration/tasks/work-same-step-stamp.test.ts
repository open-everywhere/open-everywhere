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
  type SeatScript,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2339SBOT";
const MEMBER_A = "U0OPE2339SAA";
const W_FIRST_STEP_HOLD_MS = 12_000;
const CHILD_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const BRIEF_1 = "ope2339 same-step job 1: list the open invoices";
const BRIEF_2 = "ope2339 same-step job 2: list the closed invoices";
const RESULT = "ope2339 same-step job result";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2339SBOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2339s-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2339s", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 23395) };
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

const DISPATCH: SeatScript = {
  parent: [
    {
      calls: [
        { tool: "work", input: { message: BRIEF_1 }, id: "ope2339s-work-1" },
        { tool: "work", input: { message: BRIEF_2 }, id: "ope2339s-work-2" },
      ],
    },
    { say: NO_REPLY_SENTINEL },
  ],
  work: [{ delayMs: W_FIRST_STEP_HOLD_MS, calls: [{ tool: "eve__task_cancel", input: { taskId: "agent-ope2339-none" }, id: "ope2339s-w-stall" }] }],
};

const CHILDREN: SeatScript = { parent: [{ say: NO_REPLY_SENTINEL }], child: [{ delayMs: CHILD_HOLD_MS, say: RESULT }] };

test("a job started one step late is refused before any child runs, and is re-sent to start under its own stamp", async () => {
  armSlack();
  await bootAgent();
  const cursor = await auditCursor();

  const dispatch = disposeLater(registerScript(DISPATCH));
  afterThisTest(() => dispatch.releaseHolds());
  const ts = slackTs(Date.now(), 23396);
  const res = await slackMentionWake({ channelId: SLACK_CHANNEL, userId: MEMBER_A, text: `<@${SLACK_BOT}> ope2339 please run both invoice jobs`, ts, eventId: `EvOPE2339S${ts.replace(".", "")}` });
  expect(res.status).toBe(200);

  await waitFor(() => dispatch.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's dispatch turn to serve its last step", TURN_END_CEILING_MS);
  await waitFor(() => dispatch.requests.find((r) => r.role === "work" && r.stepIndex === 0), "W's first (held) step");
  const receiptRequest = async (callId: string) =>
    waitFor(() => {
      const out = dispatch.requests.flatMap((r) => r.toolResults).find((t) => t.name === "work" && t.id === callId)?.output;
      return /"requestId"\s*:\s*"([^"]+)"/.exec(typeof out === "string" ? out : (JSON.stringify(out) ?? ""))?.[1];
    }, `the seat's receipt for ${callId}`);
  const request1 = await receiptRequest("ope2339s-work-1");
  const request2 = await receiptRequest("ope2339s-work-2");
  expect(request2).not.toBe(request1);

  dispatch.dispose();
  const children = disposeLater(registerScript(CHILDREN));
  afterThisTest(() => children.releaseHolds());
  const results = disposeLater(armSettlement(dispatch, { parent: [{ say: NO_REPLY_SENTINEL }] }));

  const refused = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.needs_reissue"], { limit: 50 });
    return rows.find((r) => detailOf(r).requestId === request1 || detailOf(r).requestId === request2);
  }, "a work.needs_reissue row for one of the two jobs", TURN_END_CEILING_MS);
  const late = String(detailOf(refused).requestId);
  const other = late === request1 ? request2 : request1;
  expect(
    [detailOf(refused).edge, detailOf(refused).reason, detailOf(refused).stamped, detailOf(refused).outcome],
    "🔴 the late job was not refused at validate under the other job's stamp, and re-sent",
  ).toEqual(["validate", "stamp-names-another-request", other, "redelivered"]);

  const keyed = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.task_keyed"], { limit: 50 });
    return rows.some((r) => detailOf(r).requestId === request1) && rows.some((r) => detailOf(r).requestId === request2) ? rows : undefined;
  }, "both jobs' work.task_keyed rows", TURN_END_CEILING_MS);
  expect(keyed.map((r) => [detailOf(r).requestId, detailOf(r).verdict, r.principalId]).sort(), "🔴 a task started under another job's stamp, or a job started twice").toEqual(
    [
      [request1, "keyed", MEMBER_A],
      [request2, "keyed", MEMBER_A],
    ].sort(),
  );
  const started = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 50 })).filter((r) => detailOf(r).request === request1 || detailOf(r).request === request2);
  expect(started.map((r) => detailOf(r).request).sort(), "each job started exactly once").toEqual([request1, request2].sort());
  expect(
    (await rowsSinceCursor(cursor, ["work.needs_reissue"], { limit: 50 })).filter((r) => detailOf(r).edge !== "validate" || detailOf(r).outcome !== "redelivered"),
    "the host's one re-send was not enough: the seat was woken, or the tripwire fired",
  ).toEqual([]);
  await waitFor(() => children.requests.filter((r) => r.role === "child").length >= 2 ? true : undefined, "both children's (held) model calls", TURN_END_CEILING_MS);
  expect(children.requests.filter((r) => r.role === "child" && r.stepIndex === 0).map((r) => (promptOf(r).includes(BRIEF_1) ? 1 : promptOf(r).includes(BRIEF_2) ? 2 : 0)).sort(), "the two children did not read the two briefs").toEqual([1, 2]);

  children.releaseHolds();
  for (const row of started) {
    const read = await awaitWorkResult({ handle: results, taskId: String(detailOf(row).task), label: `the seat's result turn for ${String(detailOf(row).request)}` });
    expect(promptOf(read)).toContain(RESULT);
  }
  for (const [h, label] of [[dispatch, "the dispatch entry"], [children, "the children"], [results, "the result turns"]] as const) assertNoFault(h, label);
});
