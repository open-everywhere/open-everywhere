import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  disposeLater,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  redeliveryRecoveryNote,
  registerScript,
  rowsSinceCursor,
  toolSessionIdentity,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  wrapToolExecute,
  type ToolSessionIdentity,
} from "../harness";

test("two work calls in one step start two workers that both run", async () => {
  await bootAgent();

  let workerToolCalls = 0;
  const workerIdentities: (ToolSessionIdentity | undefined)[] = [];
  const toolContexts: { readonly keys: readonly string[]; readonly callId: unknown; readonly toolName: unknown; readonly sessionId: unknown; readonly parentSessionId: unknown }[] = [];
  afterThisTest(
    wrapToolExecute("post_file", async (_input: unknown, options: unknown) => {
      workerToolCalls += 1;
      workerIdentities.push(toolSessionIdentity());
      const ctx = (options !== null && typeof options === "object" ? options : {}) as {
        callId?: unknown;
        toolName?: unknown;
        session?: { id?: unknown; parent?: { sessionId?: unknown } };
      };
      toolContexts.push({
        keys: Object.keys(ctx),
        callId: ctx.callId,
        toolName: ctx.toolName,
        sessionId: ctx.session?.id,
        parentSessionId: ctx.session?.parent?.sessionId,
      });
      return { posted: true, count: 1 };
    }),
  );

  const dispatched = disposeLater(
    registerScript({
      parent: [
        {
          calls: [
            { tool: "work", input: { message: "worker ALPHA: work only inside ./alpha" }, id: "ope584-alpha" },
            { tool: "work", input: { message: "worker BRAVO: work only inside ./bravo" }, id: "ope584-bravo" },
          ],
        },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [
        {
          delayMs: 120_000,
          calls: [
            {
              tool: "post_file",
              input: { files: [{ source: { path: "probe.txt" }, filename: "probe.txt" }], comment: "probe" },
              id: "ope584-probe",
            },
          ],
        },
        { say: "worker done" },
      ],
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> run two jobs at once" });

  const receiptStep = await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the dispatch turn's receipt step",
  );
  const settlement = disposeLater(armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const receipts = [
    await workTaskIdOfCall(cursor, dispatched, "ope584-alpha", "the ALPHA forward"),
    await workTaskIdOfCall(cursor, dispatched, "ope584-bravo", "the BRAVO forward"),
  ];
  expect(new Set(receipts).size).toBe(2);
  dispatched.releaseHolds();

  await waitForChildren(dispatched, { count: 2, lastStepIndex: 1, label: "both delegated workers to serve their whole arm" });
  await waitFor(() => (dispatched.holdsCutShort() >= 2 ? true : undefined), "both workers' holds to end on the release");

  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const dispatchStep = dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(dispatchStep.tools).toContain("work");
  const delegations = dispatched.requests
    .filter((r) => r.role === "parent" && r.sessionId === dispatchStep.sessionId)
    .flatMap((r) => r.toolResults)
    .filter((t) => t.name === "work");
  const requestIdOf = (output: unknown): string | undefined =>
    /"requestId"\s*:\s*"([^"]+)"/.exec(typeof output === "string" ? output : JSON.stringify(output) ?? "")?.[1];
  const delegationTaskIds = new Set(delegations.map((t) => String(requestIdOf(t.output))));
  expect(delegationTaskIds.has("undefined")).toBe(false);
  expect(delegationTaskIds.size).toBeGreaterThanOrEqual(2);
  if (delegationTaskIds.size > 2) {
    const note = redeliveryRecoveryNote();
    expect(
      note,
      `${delegationTaskIds.size} distinct delegation receipts on the seat's own session, but this ` +
        "fork observed no inline-step recovery to explain the excess — this looks like a real " +
        "double-dispatch defect, not the known OPE-582 redelivery artifact.",
    ).not.toBe("");
  }
  expect(delegations.filter((t) => t.isError)).toEqual([]);

  const workerSessions = new Set(dispatched.requests.filter((r) => r.role === "child").map((r) => String(r.sessionId)));
  expect(workerSessions.size).toBeGreaterThanOrEqual(2);
  if (workerSessions.size > 2) {
    const note = redeliveryRecoveryNote();
    expect(
      note,
      `${workerSessions.size} distinct worker sessions, but this fork observed no inline-step ` +
        "recovery to explain the excess — this looks like a real double-dispatch defect, not the " +
        "known OPE-582 redelivery artifact.",
    ).not.toBe("");
  }
  expect(workerSessions.has(String(dispatchStep.sessionId))).toBe(false);
  const startedRows = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 200 })).filter((r) =>
    receipts.includes(String(r.detail?.task)),
  );
  const workSessions = new Set(startedRows.map((r) => String(r.detail?.session)));
  expect(startedRows.length).toBe(2);
  expect(workSessions.size, "both forwards ran in ONE work session").toBe(1);
  const workSessionId = [...workSessions][0]!;
  expect(workSessionId).not.toBe(String(dispatchStep.sessionId));
  expect(workerSessions.has(workSessionId)).toBe(false);

  expect(workerToolCalls).toBeGreaterThanOrEqual(2);

  // eve 1.x passes its tool context (`context/build-base-tool-context.js`) as the second argument:
  // `callId` and `toolName` for the call, and the public `session` view of the context container.
  expect(
    new Set(toolContexts.map((c) => `${String(c.sessionId)}\u0000${String(c.callId)}`)).size,
    "each tool call is unique within its session (both workers run the same scripted call id)",
  ).toBe(toolContexts.length);
  expect(toolContexts.length).toBeGreaterThanOrEqual(2);
  for (const [i, ctx] of toolContexts.entries()) {
    expect(ctx.keys).toContain("callId");
    expect(ctx.keys).not.toContain("toolCallId");
    expect(ctx.callId, `call ${i}'s callId is the model's own tool-call id`).toMatch(/^ope584-probe(#\d+)?$/);
    expect(ctx.toolName).toBe("post_file");
    const identity = workerIdentities[i];
    expect(ctx.sessionId, "the tool context's session is the session the context container names").toBe(identity?.sessionId);
    expect(ctx.parentSessionId, "the tool context's parent is the parent the context container names").toBe(identity?.parentSessionId);
  }

  const identities = workerIdentities.filter((i): i is ToolSessionIdentity => i !== undefined);
  expect(
    identities.length,
    `toolSessionIdentity() returned undefined for ${workerIdentities.length - identities.length} of ` +
      `${workerIdentities.length} worker tool calls — the harness reach into eve's context container ` +
      "is broken, not the product. Check harness.ts's sandboxIdentityKeyNames against eve's " +
      "context/keys.js and runtime/sessions/runtime-context-keys.js.",
  ).toBe(workerIdentities.length);
  expect(identities.length).toBeGreaterThanOrEqual(2);
  const parentSessionId = workSessionId;
  for (const worker of identities) {
    expect(worker.parentSessionId).toBe(parentSessionId);
    expect(worker.sessionId).not.toBe(parentSessionId);
    expect(worker.sandboxSessionId).toBe(parentSessionId);
    expect(worker.sandboxKey).toBe(parentSessionId);
    expect(worker.sandboxKey).not.toBe(worker.sessionId);
  }
  expect(new Set(identities.map((i) => i.sessionId)).size).toBeGreaterThanOrEqual(2);
  expect(new Set(identities.map((i) => i.sandboxKey)).size).toBe(1);

  for (const taskId of receipts) {
    const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `the seat step that read ${taskId}'s result` });
    expect(resultStep.turnId, `${taskId}'s result arrives in a seat turn of its own (OPE-2338)`).not.toBe(receiptStep.turnId);
  }

  const foreignTurns = dispatched.requests.filter((r) => r.role === "parent" && r.turnId !== receiptStep.turnId);
  expect(foreignTurns.map((r) => String(r.turnId))).toEqual([]);

  for (const h of [dispatched, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }
});
