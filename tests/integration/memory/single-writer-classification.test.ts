import { expect, test } from "vitest";

import {
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  waitFor,
  waitForChildren,
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

test("one delegating wake logs the single-writer skip EXACTLY once — for the child, never for the seat", async () => {
  await bootAgent();

  const handle: ScriptedHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "look something up for me" }, id: "ope1065-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ say: "child done" }],
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
      "the parent's terminal step",
    );
    await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated child's terminal step" });
  } finally {
    restore();
  }

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const { SUBAGENT_SKIP_MARKER } = await import("@open-everywhere/core/agent/hooks/memory.js");
  const memoryLines = lines.filter((l) => l.includes(MEMORY_LOG_PREFIX));
  const skips = memoryLines.filter((l) => l.includes("session.started:") && l.includes(SUBAGENT_SKIP_MARKER));

  expect(skips).toHaveLength(1);

  const pastTheGate = memoryLines.filter(
    (l) => l.includes("session.started: no memory synced") || /synced \d+ file\(s\)/.test(l),
  );
  expect(pastTheGate).toHaveLength(1);
});
