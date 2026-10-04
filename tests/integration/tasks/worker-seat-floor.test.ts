import { expect, test } from "vitest";

import {
  afterThisTest,
  auditCursor,
  awaitTaskSettlement,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  SETTLEMENT_DRAIN_SCRIPT,
  sleep,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type RecordedRequest,
} from "../harness";

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

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "count the files in the repo" }, id: "ope863-delegate" }] },
        { say: "handing this off" },
      ],
      child: [{ say: "there are twelve files" }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> count the files" });

  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's own terminal step to be served");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the delegated worker to serve its arm" });
  const taskId = taskIdOfDelegation(dispatched, "the OPE-863 delegation");
  const { handle: drain } = await awaitTaskSettlement({
    dispatched,
    taskId,
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the settled worker's completion wake",
  });
  afterThisTest(() => drain.dispose());
  expect(drain.requests.filter((r) => r.fault !== undefined)).toEqual([]);

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
  expect([...seatTools]).toContain("agent");
  expect([...childTools]).not.toContain("agent");
});

test("a delegated worker's mounted toolset is written to the audit trail, once, at the mount", async () => {
  await bootAgent();

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "count the files in the repo" }, id: "ope1497-delegate" }] },
        { say: "handing this off" },
      ],
      child: [
        { calls: [{ tool: "update_status", input: { state: "working", summary: "counting the files" }, id: "ope1497-status" }] },
        { say: "there are twelve files" },
      ],
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> count the files" });

  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's own terminal step to be served");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to serve its whole arm" });
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

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
  expect(detail.parentSession).toBe(seatSessionId);
  expect(settled.filter((r) => (r.detail ?? {}).worker === seatSessionId)).toEqual([]);

  expect([...(detail.tools as string[])].sort()).toEqual(offered);
  expect(detail.toolCount).toBe(offered.length);

  expect(detail.tools).not.toContain("no_reply");
  expect(detail.tools).not.toContain("stand_down");
  expect(detail.withheld).toContain("no_reply");
  expect(detail.withheld).toContain("stand_down");
  for (const kept of ["reply", "bash", "update_status"]) expect(detail.tools).toContain(kept);
});
