import { expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type ScriptedHandle,
} from "../harness";

const DISCORD_BOT_ID = "9000000000000000001";

const MEMORY_LOG_PREFIX = "[open-everywhere:memory]";

function captureConsole(sink: string[]): () => void {
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    sink.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    original(...(args as []));
  };
  return () => {
    console.log = original;
  };
}

test("one forwarding wake has ONE memory writer — the work session; the forwarding seat and the child each skip exactly once", async () => {
  await bootAgent();

  const cursor = await auditCursor();
  const handle: ScriptedHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "look something up for me" }, id: "ope1065-delegate" }] },
        { say: "NO_REPLY" },
      ],
      child: [{ delayMs: 120_000, say: "child done" }],
    }),
  );

  const lines: string[] = [];
  const restore = captureConsole(lines);
  try {
    await discordMentionWake({
      channelId: DISCORD_LISTED_CHANNEL_ID,
      text: `<@${DISCORD_BOT_ID}> please delegate this one`,
    });
    await waitFor(
      () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
      "the parent's pre-wait step",
    );
    await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated child's terminal step" });
    const taskId = await workTaskIdOfCall(cursor, handle, "ope1065-delegate", "the forward receipt");
    const settlement = disposeLater(armSettlement(handle, { parent: [{ say: "NO_REPLY" }] }));
    handle.releaseHolds();
    const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat's step with the worker's result" });
    expect(resultStep.stepIndex, "the result-wake turn's one step").toBe(0);
    expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    await awaitWindowQuiet();
  } finally {
    restore();
  }

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.requests.some((r) => r.role === "parent" && r.stepIndex < 0), "a parent step after the dispatch turn's last step was requested").toBe(false);

  const { SUBAGENT_SKIP_MARKER, FORWARDING_SEAT_SKIP_MARKER } = await import("@open-everywhere/core/agent/hooks/memory.js");
  const memoryLines = lines.filter((l) => l.includes(MEMORY_LOG_PREFIX));
  const startedLines = memoryLines.filter((l) => l.includes("session.started:"));

  expect(startedLines.filter((l) => l.includes(SUBAGENT_SKIP_MARKER))).toHaveLength(1);

  expect(startedLines.filter((l) => l.includes(FORWARDING_SEAT_SKIP_MARKER))).toHaveLength(1);

  const pastTheGate = memoryLines.filter(
    (l) => l.includes("session.started: no memory synced") || /synced \d+ file\(s\)/.test(l),
  );
  expect(pastTheGate).toHaveLength(1);
});
