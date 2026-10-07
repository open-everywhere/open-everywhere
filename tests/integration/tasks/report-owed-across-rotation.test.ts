import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { workLedgerId, workReportPromised } from "@open-everywhere/core/agent/channels/work.js";

import {
  afterThisTest,
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
  WAKE_FROM_ENVELOPE,
  WAKE_FROM_REPORT,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2360BOT";
const MEMBER = "U0OPE2360AAA";
const CHILD_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const BRIEF = "ope2360: summarise the release notes in one line and include the token rel-2360";
const HANDOFF = "ope2360: I've started that and will reply here with the one-line summary.";
const RESULT = "ope2360 worker result: rel-2360 ships the three-tier seat";
const RELAY = "ope2360: rel-2360 — the release ships the three-tier seat.";

const posted: { readonly channel: string; readonly text: string }[] = [];
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2360BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2360-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2360", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") {
      posted.push({ channel: params.get("channel") ?? "", text: params.get("text") ?? "" });
      return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 23600 + posted.length) };
    }
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

async function mention(text: string, micros: number): Promise<void> {
  const ts = slackTs(Date.now(), micros);
  const res = await slackMentionWake({ channelId: SLACK_CHANNEL, userId: MEMBER, text: `<@${SLACK_BOT}> ${text}`, ts, eventId: `EvOPE2360${micros}${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the mention: ${res.body.slice(0, 300)}`).toBe(200);
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

test("a job forwarded in generation N is reported to the asking room after the seat rotates to N+1", async () => {
  armSlack();
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();
  const callId = "ope2360-forward";

  const job = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: BRIEF }, id: callId }] },
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: HANDOFF, done: false }, id: "ope2360-handoff" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: CHILD_HOLD_MS, say: RESULT }],
    }),
  );
  afterThisTest(() => job.releaseHolds());
  await mention("ope2360 please summarise the release notes", 23601);
  const handoffStep = await waitFor(() => job.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's hand-off step", TURN_END_CEILING_MS);
  const oldSeatSession = handoffStep.sessionId;
  await waitFor(() => job.requests.find((r) => r.role === "child"), "the child's held step — the job is running");
  const taskId = await workTaskIdOfCall(cursor, job, callId, "the forwarded job");
  assertNoFault(job, "generation N's turn");

  const forwarded = (await rowsSinceCursor(cursor, ["work.forwarded"]))[0];
  const requestId = String(detailOf(forwarded).requestId ?? "");
  expect(requestId.length, "the forward names its request").toBeGreaterThan(0);

  const handoffPost = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => detailOf(r).sessionId === oldSeatSession);
    return rows.length > 0 ? rows[0] : undefined;
  }, "the hand-off note's reply.post row");
  expect(detailOf(handoffPost).done, "🔴 OPE-2361: the hand-off note's reply.post row carries done:false").toBe(false);
  expect(await waitFor(async () => ((await workReportPromised(store, org, requestId)) ? true : undefined), "the store-held promise"), "🔴 the store holds the seat's promise").toBe(true);

  const wToken = String(detailOf(forwarded).workToken ?? "");
  const windowId = /:win:w\/([^:]+):oe-sup:/u.exec(wToken)?.[1];
  expect(windowId, "the forward names W's token").toBeDefined();
  const seatKey = `oe-domain::${windowId}`;
  const seatBefore = (await store.getChannelSession(org, seatKey))!;
  job.dispose();
  const rotationTurn = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
  expect(await store.markChannelSessionRotation(org, seatKey, new Date().toISOString())).toBe(true);
  await mention("ope2360 are you there?", 23602);
  const rotatedStep = await waitFor(() => rotationTurn.requests.find((r) => r.role === "parent" && r.sessionId !== oldSeatSession), "the rotated seat's first step — a NEW seat session", TURN_END_CEILING_MS);
  const newSeatSession = rotatedStep.sessionId;
  expect((await store.getChannelSession(org, seatKey))!.token, "the seat rotated to a new generation").not.toBe(seatBefore.token);
  rotationTurn.dispose();

  const resultTurn = disposeLater(
    registerScript(
      {
        parent: [
          { calls: [{ tool: "no_reply", input: { reason: "not_relevant" }, id: "ope2360-quiet" }] },
          { calls: [{ tool: "reply", input: { wake: WAKE_FROM_REPORT, text: RELAY, done: true }, id: "ope2360-report" }] },
          { say: NO_REPLY_SENTINEL },
        ],
      },
      newSeatSession,
    ),
  );
  const postedBefore = posted.length;
  job.releaseHolds();
  const read = await awaitWorkResult({ handle: resultTurn, taskId, label: "the rotated seat's result step" });

  expect(read.sessionId, "the result reaches the seat's CURRENT generation").toBe(newSeatSession);
  expect(read.sessionId).not.toBe(oldSeatSession);
  expect(promptOf(read), "🔴 the rotated session reads the request the earlier session forwarded").toContain(BRIEF);
  expect(promptOf(read), "🔴 …and the note that says the seat rotated").toContain("did not forward this job");
  expect(promptOf(read)).toContain(RESULT);

  const skipped = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["delegation.settlement_report_skipped"])).filter((r) => detailOf(r).task === workLedgerId(requestId));
    return rows.length > 0 ? rows : undefined;
  }, "🔴 the delegation.settlement_report_skipped row — RED before OPE-2360: the rotated session's no_reply was accepted");
  expect(skipped).toHaveLength(1);

  await waitFor(() => resultTurn.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the rotated session's report step", TURN_END_CEILING_MS);
  const reportPost = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => detailOf(r).sessionId === newSeatSession && detailOf(r).done === true);
    return rows.length > 0 ? rows[0] : undefined;
  }, "the report's reply.post row on the rotated session");
  expect(reportPost?.platform, "the report landed on the surface that asked").toBe("slack");
  const reported = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["delegation.settlement_report_posted"])).filter((r) => detailOf(r).task === workLedgerId(requestId));
    return rows.length > 0 ? rows : undefined;
  }, "the delegation.settlement_report_posted row");
  expect(reported).toHaveLength(1);
  expect(posted.slice(postedBefore).some((p) => p.channel === SLACK_CHANNEL && p.text.includes("rel-2360")), "🔴 the asking Slack channel received the report").toBe(true);

  const wake = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.result_wake"])).filter((r) => detailOf(r).taskId === taskId && detailOf(r).outcome === "delivered");
    return rows.length > 0 ? rows[0] : undefined;
  }, "the delivered work.result_wake row");
  expect([detailOf(wake).reportOwed, detailOf(wake).seatRotated], "the result wake row records the promise and the rotation").toEqual([true, true]);
  expect(await workReportPromised(store, org, requestId), "one hand-off note arms one duty: the promise is spent").toBe(false);
  assertNoFault(resultTurn, "the rotated session's result turn");
});
