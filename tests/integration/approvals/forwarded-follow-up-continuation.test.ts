// proves: AP-MOD-core-access-worker-continuation, AP-MOD-core-access-forwarded-asks

import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  consumeSettlement,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  SETTLEMENT_DRAIN_SCRIPT,
  waitFor,
  workSessionCalls,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const REQUESTER_HEADING = "Requester's visible messages:";
const STARTER_ROUTINE_RULE = "routine-reports-here";
const HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;
const BOT = "<@9000000000000000001>";

const KEEPER_BRIEF = "ope2372 keeper job: watch the inbox for the rest of the day";
const OPEN_BRIEF = "ope2372 job: draft the weekly numbers summary";
const FOLLOW_BRIEF = "ope2372 follow-up: now set up a routine that sends that summary every weekday";
const OPEN_RESULT = "ope2372 the weekly summary is drafted";

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

function currentSection(prompt: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.indexOf(REQUESTER_HEADING);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("> ")) break;
    out.push(line.slice(2));
  }
  return out;
}

async function armJudge(askNonce: string): Promise<{ prompts: string[] }> {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("enforce");
  const judge = await import("@open-everywhere/core/agent/access/approval-judge.js");
  const prompts: string[] = [];
  judge.registerApprovalJudgeCompletion(async (prompt, pass) => {
    if (pass === "scrutiny") return "YES";
    prompts.push(prompt);
    return currentSection(prompt).some((line) => line.includes(askNonce))
      ? `VERDICT: allow\nREASON: the requester asked for this routine in this turn\nRULE: ${STARTER_ROUTINE_RULE}`
      : "VERDICT: ask\nREASON: no verified requester message from this turn asks for this";
  });
  afterThisTest(() => judge.resetApprovalJudgeCompletion());
  return { prompts };
}

function requestIdOfWork(handle: ScriptedHandle, callId: string): string | undefined {
  const result = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "work" && t.id === callId);
  if (result === undefined) return undefined;
  const raw = result.output;
  return /"requestId"\s*:\s*"([^"]+)"/.exec(typeof raw === "string" ? raw : (JSON.stringify(raw) ?? ""))?.[1];
}

test("a person's follow-up continues the SAME work-session child in a multi-wake work turn, and the child's judge reads the follow-up as the current ask", async () => {
  await bootAgent();
  const openNonce = `open-${randomBytes(4).toString("hex")}`;
  const followNonce = `follow-${randomBytes(4).toString("hex")}`;
  const { prompts } = await armJudge(followNonce);
  const cursor = await auditCursor();
  const workMark = workSessionCalls().length;

  const keeper = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: KEEPER_BRIEF }, id: "ope2372-keep" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: HOLD_MS, say: "ope2372 the inbox was quiet" }],
    }),
  );
  afterThisTest(() => keeper.releaseHolds());
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT} ope2372 please keep an eye on the inbox today` });
  await waitFor(() => keeper.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the keeper's seat turn to serve its last step", TURN_END_CEILING_MS);
  await waitFor(() => keeper.requests.find((r) => r.role === "child" && promptOf(r).includes(KEEPER_BRIEF)), "the keeper child's first (held) model call");
  const keeperTask = await workTaskIdOfCall(cursor, keeper, "ope2372-keep", "the keeper job");
  const seat = String(keeper.requests.find((r) => r.role === "parent")?.sessionId);
  assertNoFault(keeper, "the keeper's turn");
  keeper.dispose();

  const opening = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: OPEN_BRIEF }, id: "ope2372-open" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: HOLD_MS, say: OPEN_RESULT }],
    }),
  );
  afterThisTest(() => opening.releaseHolds());
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT} ${openNonce} please draft the weekly numbers summary` });
  await waitFor(() => opening.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the opening seat turn to serve its last step", TURN_END_CEILING_MS);
  const childRunOne = await waitFor(() => opening.requests.find((r) => r.role === "child" && promptOf(r).includes(OPEN_BRIEF)), "the opening child's first (held) model call");
  const taskId = await workTaskIdOfCall(cursor, opening, "ope2372-open", "the opening job");
  const child = String(childRunOne.sessionId);
  expect(taskId, "the opening job and the keeper started ONE task").not.toBe(keeperTask);
  assertNoFault(opening, "the opening turn");
  const openResult = disposeLater(armSettlement(opening, SETTLEMENT_DRAIN_SCRIPT));
  opening.releaseHolds();
  const openRead = await consumeSettlement({ armed: openResult, dispatched: opening, taskId, label: "the seat's step that read the opening job's result" });
  expect(promptOf(openRead), "the opening job's result did not reach the seat").toContain(OPEN_RESULT);
  assertNoFault(openResult, "the opening job's result turn");
  openResult.dispose();
  expect(keeper.holdsCutShort(), "the keeper's hold ended early, so W's turn may have closed").toBe(0);

  const followCursor = await auditCursor();
  const runTwo = disposeLater(
    registerScript(
      {
        parent: [],
        child: [
          {
            delayMs: HOLD_MS,
            calls: [
              {
                tool: "create_routine",
                input: { prompt: "send the weekly numbers summary", trigger: { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } },
                id: "ope2372-routine",
              },
            ],
          },
          { say: "ope2372 the routine is set up" },
        ],
      },
      child,
    ),
  );
  afterThisTest(() => runTwo.releaseHolds());
  const follow = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: FOLLOW_BRIEF, taskId }, id: "ope2372-follow" }] },
        { delayMs: HOLD_MS, say: NO_REPLY_SENTINEL },
      ],
    }),
  );
  afterThisTest(() => follow.releaseHolds());
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT} ${followNonce} thanks, now set up a routine that sends that summary every weekday morning` });
  const receipt = await waitFor(() => follow.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope2372-follow"), "the follow-up's `work` receipt");
  expect(receipt.isError, `the seat refused the follow-up itself: ${JSON.stringify(receipt.output)}`).toBe(false);
  const followRequest = requestIdOfWork(follow, "ope2372-follow");
  expect(followRequest, "the follow-up's `work` receipt named no request id").toEqual(expect.any(String));

  const outcome = await waitFor(async () => {
    const rows = await rowsSinceCursor(followCursor, ["delegation.task_started", "delegation.continuation_refused", "work.request_refused"], { limit: 100 });
    return (
      rows.find((r) => r.action === "delegation.task_started" && detailOf(r).task === taskId && detailOf(r).continuation === true) ??
      rows.find((r) => r.action !== "delegation.task_started" && (detailOf(r).task === taskId || detailOf(r).requestId === followRequest))
    );
  }, "the work session to continue the opening task, or to refuse the follow-up");
  expect([outcome.action, detailOf(outcome).reason], "🔴 the work session refused the follow-up instead of continuing the task").toEqual(["delegation.task_started", undefined]);
  expect(detailOf(outcome).request, "the continuation ran under another job than the follow-up").toBe(followRequest);

  await waitFor(() => follow.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the follow-up turn's held last step", TURN_END_CEILING_MS);
  const runTwoResult = disposeLater(armSettlement(follow, SETTLEMENT_DRAIN_SCRIPT));
  follow.releaseHolds();
  runTwo.releaseHolds();
  await waitFor(() => runTwo.requests.find((r) => r.role === "child" && r.stepIndex === 1), "run 2's terminal step");
  expect(runTwo.requests.length, "run 2 never reached the opening child").toBeGreaterThanOrEqual(2);
  expect(runTwo.requests.every((r) => r.sessionId === child), "🔴 the follow-up reached a different child").toBe(true);
  assertNoFault(runTwo, "run 2");
  await awaitWorkResult({ handle: runTwoResult, taskId, label: "the seat's step that read run 2's result" });
  assertNoFault(follow, "the follow-up turn");
  assertNoFault(runTwoResult, "run 2's result turn");

  const admitted = await waitFor(
    async () => (await rowsSinceCursor(followCursor, ["delegation.continuation_admitted"], { limit: 50 })).find((r) => detailOf(r).task === taskId && detailOf(r).session !== seat),
    "the work session's own delegation.continuation_admitted row",
  );
  const workSession = String(detailOf(admitted).session);
  const workTurns = new Set(workSessionCalls().slice(workMark).filter((c) => c.sessionId === workSession).map((c) => c.turnId));
  expect([...workTurns], "the keeper, the opening job and the follow-up did not share ONE work-session turn — this run did not drive a multi-wake turn").toEqual([detailOf(admitted).turn]);

  const forRoutine = await waitFor(() => {
    const hits = prompts.filter((p) => p.includes("Action: create_routine"));
    return hits.length > 0 ? hits : undefined;
  }, "the judge to be consulted for run 2's create_routine proposal");
  for (const p of forRoutine) {
    expect(currentSection(p).some((line) => line.includes(followNonce)), "🔴 the judge did not read the follow-up as THIS turn's ask").toBe(true);
    expect(currentSection(p).some((line) => line.includes(openNonce)), "the judge read the OPENING ask as this turn's").toBe(false);
  }
  const rows = await waitFor(async () => {
    const got = await rowsSinceCursor(followCursor, ["approval.chain", "approval.judge.verdict", "approval.autoapproved", "approval.requested"], { limit: 100 });
    return got.some((r) => r.action === "approval.judge.verdict" && detailOf(r).tool === "create_routine") && got.some((r) => r.action === "approval.autoapproved" || r.action === "approval.requested") ? got : undefined;
  }, "run 2's approval rows for create_routine");
  const chain = rows.find((r) => r.action === "approval.chain" && detailOf(r).tool === "create_routine");
  expect([detailOf(chain).verdict, detailOf(chain).resolvedBy], "the chain did not allow run 2's act on the judge's word").toEqual(["allow", "judge"]);
  expect(rows.some((r) => r.action === "approval.autoapproved"), "run 2's act was not auto-approved").toBe(true);
  expect(rows.filter((r) => r.action === "approval.requested"), "run 2's act got a card").toEqual([]);

  runTwoResult.dispose();
  const keeperResult = disposeLater(armSettlement(follow, SETTLEMENT_DRAIN_SCRIPT));
  keeper.releaseHolds();
  await awaitWorkResult({ handle: keeperResult, taskId: keeperTask, label: "the seat's step that read the keeper's result" });
  assertNoFault(keeperResult, "the keeper's result turn");
});
