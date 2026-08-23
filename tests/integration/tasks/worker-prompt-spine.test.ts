import { expect, test } from "vitest";
import {
  afterThisTest,
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
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
  expect(childPrompt).not.toContain("`return_result`");

  for (const block of SEAT_ONLY) expect(seatPrompt).toContain(block);
  expect(seatPrompt).not.toContain("## Your job");

  const childTools = new Set(childRequests[0]!.tools);
  const seatTools = new Set(parentRequests[0]!.tools);
  expect(childTools.size).toBeGreaterThan(20);
  expect(seatTools.size).toBeGreaterThan(5);
  expect([...childTools]).not.toContain("return_result");
  expect([...childTools]).not.toContain("stand_down");
  expect([...childTools]).not.toContain("no_reply");

  for (const kept of ["reply", "update_status", "bash", "post_file"]) expect([...childTools]).toContain(kept);
  for (const kept of ["stand_down", "no_reply"]) expect([...seatTools]).toContain(kept);
  expect([...seatTools]).not.toContain("return_result");
  expect([...seatTools]).toContain("agent");
  expect([...childTools]).not.toContain("agent");
});
