import { expect, test } from "vitest";

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
  sleep,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type RecordedRequest,
} from "../harness";

const RECEIPT_STEP = [{ say: NO_REPLY_SENTINEL }] as const;

interface DrivenForward {
  readonly taskId: string;
  readonly workSessionId: string;
}

async function driveForward(
  dispatched: ReturnType<typeof registerScript>,
  input: { readonly childLastStep: number; readonly callId: string; readonly cursor: Awaited<ReturnType<typeof auditCursor>> },
): Promise<DrivenForward> {
  const receiptStep = await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the dispatch turn's receipt step to be served",
  );
  const settlement = disposeLater(armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(input.cursor, dispatched, input.callId, "the forward receipt");
  dispatched.releaseHolds();
  await waitForChildren(dispatched, { count: 1, lastStepIndex: input.childLastStep, label: "the delegated worker to serve its whole arm" });
  await waitFor(() => (dispatched.holdsCutShort() === 1 ? true : undefined), "the worker's hold ended on the release, not on its 120 s backstop");
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the worker's result" });
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, "the result arrives in a seat turn of its own (OPE-2338)").not.toBe(receiptStep.turnId);
  for (const h of [dispatched, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }
  settlement.dispose();
  const started = (await rowsSinceCursor(input.cursor, ["delegation.task_started"], { limit: 200 })).find(
    (r) => (r.detail as { task?: unknown } | undefined)?.task === taskId,
  );
  const workSessionId = (started?.detail as { session?: unknown } | undefined)?.session;
  if (typeof workSessionId !== "string") throw new Error(`no delegation.task_started row names the session for task ${taskId}`);
  return { taskId, workSessionId };
}

function systemText(req: RecordedRequest): string {
  return req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.text)
    .join("\n\n");
}

const SEAT_ONLY = [
  "You are the standing session for this channel",
  "### When to speak",
  "A react acknowledges; it does not answer",
  "`stand_down`",
  "### Backscroll",
  "### Owned threads",
] as const;

const WORKER_ONLY = [
  "## Your job",
  "### Your report",
  "Your LAST message of this session is your report",
  "call `post_file` to attach it into the",
  "an answer might not",
] as const;

test("the delegated worker reads the worker persona, and the seat keeps its own", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "count the files in the repo" }, id: "ope863-delegate" }] },
        ...RECEIPT_STEP,
      ],
      child: [{ delayMs: 120_000, say: "there are twelve files" }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> count the files" });

  await driveForward(dispatched, { childLastStep: 0, callId: "ope863-delegate", cursor });

  const childRequests = dispatched.requests.filter((r) => r.role === "child");
  const parentRequests = dispatched.requests.filter((r) => r.role === "parent");
  expect(childRequests.length).toBeGreaterThan(0);
  expect(parentRequests.length).toBeGreaterThan(0);
  const childPrompt = systemText(childRequests[0]!);
  const seatPrompt = systemText(parentRequests[0]!);
  expect(childPrompt.length).toBeGreaterThan(1000);

  for (const block of WORKER_ONLY) expect(childPrompt).toContain(block);
  for (const block of SEAT_ONLY) expect(childPrompt).not.toContain(block);
  for (const block of SEAT_ONLY) expect(seatPrompt).toContain(block);
  expect(seatPrompt).not.toContain("## Your job");

  const childTools = new Set(childRequests[0]!.tools);
  const seatTools = new Set(parentRequests[0]!.tools);
  expect(childTools.size).toBeGreaterThan(20);
  expect(seatTools.size).toBeGreaterThan(5);
  expect([...childTools]).not.toContain("stand_down");
  expect([...childTools]).not.toContain("no_reply");

  for (const kept of ["reply", "update_status", "bash", "post_file"]) expect([...childTools]).toContain(kept);
  for (const kept of ["stand_down", "no_reply"]) expect([...seatTools]).toContain(kept);
  expect([...seatTools]).toContain("work");
  expect([...childTools]).not.toContain("agent");
  expect([...childTools]).not.toContain("work");
});

test("a delegated worker's mounted toolset is written to the audit trail, once, at the mount", async () => {
  await bootAgent();

  const cursor = await auditCursor();
  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "count the files in the repo" }, id: "ope1497-delegate" }] },
        ...RECEIPT_STEP,
      ],
      child: [
        { delayMs: 120_000, calls: [{ tool: "update_status", input: { state: "working", summary: "counting the files" }, id: "ope1497-status" }] },
        { say: "there are twelve files" },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> count the files" });

  const { workSessionId } = await driveForward(dispatched, { childLastStep: 1, callId: "ope1497-delegate", cursor });

  const childRequests = dispatched.requests.filter((r) => r.role === "child");
  const parentRequests = dispatched.requests.filter((r) => r.role === "parent");
  expect(childRequests.length).toBeGreaterThan(0);
  expect(parentRequests.length).toBeGreaterThan(0);
  const offered = [...childRequests[0]!.tools].sort();
  expect(offered.length).toBeGreaterThan(20);
  expect(childRequests.length).toBeGreaterThan(1);
  expect([...childRequests[1]!.tools].sort()).toEqual(offered);
  const childSessionId = String(childRequests[0]!.sessionId);
  const seatSessionId = String(parentRequests[0]!.sessionId);
  expect(childSessionId).not.toBe(seatSessionId);
  expect(childSessionId).not.toBe(workSessionId);
  expect(workSessionId).not.toBe(seatSessionId);

  await waitFor(
    async () => {
      const found = await rowsSinceCursor(cursor, ["worker.toolset"]);
      return found.some((r) => (r.detail ?? {}).worker === childSessionId) ? true : undefined;
    },
    "the worker's `worker.toolset` evidence row",
    90_000,
  );
  await sleep(3_000);
  const settled = await rowsSinceCursor(cursor, ["worker.toolset"]);
  const ours = settled.filter((r) => (r.detail ?? {}).worker === childSessionId);

  expect(ours.length).toBe(1);
  const row = ours[0]!;
  expect((row.detail ?? {}).reason).toBe("mount");
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  expect(row.platform).toBe("unified");
  expect(detail.grain).toBe("task");
  expect(detail.parentSession).toBe(workSessionId);
  expect(settled.filter((r) => (r.detail ?? {}).worker === seatSessionId)).toEqual([]);
  expect(settled.filter((r) => (r.detail ?? {}).worker === workSessionId)).toEqual([]);

  expect([...(detail.tools as string[])].sort()).toEqual(offered);
  expect(detail.toolCount).toBe(offered.length);

  expect(detail.tools).not.toContain("no_reply");
  expect(detail.tools).not.toContain("stand_down");
  expect(detail.withheld).toContain("no_reply");
  expect(detail.withheld).toContain("stand_down");
  for (const kept of ["reply", "bash", "update_status"]) expect(detail.tools).toContain(kept);
});
