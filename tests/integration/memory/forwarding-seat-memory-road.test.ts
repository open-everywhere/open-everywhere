import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { NATIVE_AGENT_REFUSED_MESSAGE } from "@open-everywhere/core/agent/access/native-delegation-gate.js";

import {
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type RecordedRequest,
  type ScriptedHandle,
  type ScriptedStep,
} from "../harness";

// A channel seat on the it-memory domain forwards jobs to its work session with `work`. Its per-wake
// verdict for eve's built-in `agent` is `no-seat`, and the root approval policy refuses that call.
// So the memory index the seat reads must name `work` for a save and for a lookup, never `agent`.
const IT_MEMORY_CHANNEL_ID = "1300000001500000001";
const DISCORD_BOT_ID = "9000000000000000001";
const DISCORD_TEST_GUILD_ID = "1300000000000000100";
const SILO = "it-memory-brain";
const ORG = "default";

function siloFilePath(rel: string): string {
  const dir = process.env.OE_MEMORY_DIR;
  if (!dir) throw new Error("forwarding-seat memory test: OE_MEMORY_DIR is not set — call siloFilePath() after bootAgent().");
  return join(dir, ORG, "@silos", SILO, rel);
}

function resultById(requests: readonly RecordedRequest[], id: string): { readonly isError: boolean; readonly output: unknown } | undefined {
  for (const request of requests) {
    const result = request.toolResults.find((candidate) => candidate.id === id);
    if (result !== undefined) return { isError: result.isError, output: result.output };
  }
  return undefined;
}

function systemText(request: RecordedRequest): string {
  return request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.text)
    .join("\n");
}

/** One forwarded job: the seat calls `work` (and, when asked, eve's `agent` first), a worker runs `child`, and the result reaches the seat. */
async function forwardJob(input: {
  readonly ids: string;
  readonly ask: string;
  readonly message: string;
  readonly child: readonly ScriptedStep[];
  readonly tryNativeAgentFirst?: boolean;
  readonly report?: string;
}): Promise<{ readonly handle: ScriptedHandle; readonly result: RecordedRequest }> {
  const cursor = await auditCursor();
  const calls = [
    ...(input.tryNativeAgentFirst === true ? [{ tool: "agent", input: { message: input.message }, id: `${input.ids}-agent` }] : []),
    { tool: "work", input: { message: input.message }, id: `${input.ids}-work` },
  ];
  const handle = disposeLater(
    registerScript({
      parent: [{ calls }, { say: "NO_REPLY" }],
      child: [...input.child.map((step, i) => (i === 0 ? { ...step, delayMs: 120_000 } : step)), { say: input.report ?? `${input.ids} done` }],
    }),
  );
  await discordMentionWake({ channelId: IT_MEMORY_CHANNEL_ID, text: `<@${DISCORD_BOT_ID}> ${input.ask}` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${input.ids}: the seat's receipt step`);
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: `${input.ids}: the worker to enter its held step` });
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: "NO_REPLY" }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, `${input.ids}-work`, `${input.ids}: the forward`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: input.child.length, label: `${input.ids}: the worker's terminal step` });
  const result = await awaitWorkResult({ handle: settlement, taskId, label: `${input.ids}: the seat's result-wake step` });
  expect(result.fault).toBeUndefined();
  settlement.dispose();
  return { handle, result };
}

// proves: SEAT-memory-recall, AP-MOD-core-access-native-delegation-gate
test("a forwarding channel seat is told to save and recall memory with `work`, both roads reach the silo, and its own `agent` call stays refused", async () => {
  await bootAgent({ sharedSqlite: true });
  const stamp = Date.now();
  const file = `facts-${stamp}.md`;
  const fact = `IT-FORWARD-MEMORY-${stamp}`;

  // ① Save. The seat first tries eve's `agent` (the old doctrine's verb), then hands the save off with `work`.
  const save = await forwardJob({
    ids: "fm-save",
    ask: `remember that the canary code is ${fact}`,
    message: `Open /workspace/memory/${SILO}/MEMORY.md with your file tools and add this fact for the team: the canary code is ${fact}. Reply with the exact line you wrote and the path you wrote it to.`,
    tryNativeAgentFirst: true,
    child: [{ calls: [{ tool: "write_file", input: { filePath: `/workspace/memory/${SILO}/${file}`, content: `# Facts\n\n- the canary code is ${fact}\n` }, id: "fm-save-write" }] }],
  });

  const dispatch = save.handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  const prompt = systemText(dispatch);
  expect(prompt, "precondition: the seat's prompt carries its memory index").toContain(`memory/${SILO}/`);
  expect(prompt, "the memory index tells a forwarding seat to look up with `work`").toContain("hand off a lookup: `work` with a `message`");
  expect(prompt, "the memory index tells a forwarding seat to save with `work`").toContain("hand it off THIS turn — `work` with a `message` of exactly this shape");
  expect(prompt, "the memory index never tells a forwarding seat to look up with `agent`").not.toContain("delegate a lookup: `agent`");
  expect(prompt, "the memory index never tells a forwarding seat to save with `agent`").not.toContain('`agent` with `mode: "sync"`');
  expect(dispatch.tools, "the seat is offered the verb its memory index names").toContain("work");
  const workerBlockStart = prompt.indexOf("## What a worker can do that you cannot");
  const workerBlock = prompt.slice(workerBlockStart, prompt.indexOf("### Handing work off on this seat", workerBlockStart));
  expect(workerBlockStart, "precondition: the seat's prompt carries the worker-capability block").toBeGreaterThanOrEqual(0);
  expect(workerBlock, "the worker-capability block names the seat's own hand-off verb").toContain("`work` does NOT block");
  expect(workerBlock, "the worker-capability block never tells a forwarding seat to call `agent`").not.toContain("`agent`");
  expect(workerBlock, "the worker-capability block names the seat's own cancel verb").toContain("`cancel_work`");
  expect(workerBlock, "the worker-capability block never names `eve__task_cancel`, which a forwarding seat does not hold").not.toContain("`eve__task_cancel`");
  expect(workerBlock, "the worker-capability block says the `work` receipt carries a `requestId`").toContain("`requestId`");
  expect(workerBlock, "the worker-capability block never promises a task id in the `work` receipt").not.toContain("task id from the receipt");

  const nativeAgent = resultById(save.handle.requests, "fm-save-agent");
  expect(nativeAgent?.isError, `the seat's own agent call was not refused: ${JSON.stringify(nativeAgent?.output)}`).toBe(true);
  expect(JSON.stringify(nativeAgent?.output)).toContain(NATIVE_AGENT_REFUSED_MESSAGE);
  expect(save.handle.requests.filter((r) => r.role === "child").map((r) => r.stepIndex).sort(), "only the forwarded job's worker ran; the refused `agent` call started none").toEqual([0, 1]);

  const durable = siloFilePath(file);
  await waitFor(() => (existsSync(durable) ? true : undefined), "the saved fact in the DURABLE store");
  expect(readFileSync(durable, "utf-8")).toContain(fact);
  save.handle.dispose();
  await awaitWindowQuiet();

  // ② Recall. A fresh wake hands a lookup off with `work`; its worker reads the silo and the result carries the fact.
  const recallCursor = await auditCursor();
  const recall = await forwardJob({
    ids: "fm-recall",
    ask: "what is the canary code?",
    message: `Read /workspace/memory/${SILO}/ with your file tools and report the canary code.`,
    child: [{ calls: [{ tool: "bash", input: { command: `cat /workspace/memory/${SILO}/${file}` }, id: "fm-recall-read" }] }],
    report: `The canary code is ${fact} (memory/${SILO}/${file}).`,
  });
  expect(recall.result.messages.some((m) => m.text.includes(fact)), "the recalled fact reaches the seat in the job's result").toBe(true);
  const read = resultById(recall.handle.requests, "fm-recall-read");
  expect(read?.isError, `the worker's read failed: ${JSON.stringify(read?.output)}`).toBe(false);
  expect(JSON.stringify(read?.output), "the lookup worker read the fact the save wrote").toContain(fact);
  expect(recall.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const started = await rowsSinceCursor(recallCursor, ["delegation.task_started"], { limit: 50 });
  expect(started, "the recall started exactly one task: the forwarded job").toHaveLength(1);
  recall.handle.dispose();
  await awaitWindowQuiet();
});
