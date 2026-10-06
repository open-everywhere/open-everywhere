import assert from "node:assert/strict";
import { readTaskSettled, readTaskStarted } from "../../agent/access/background-tasks.js";
import { extractMemoryPathReads, normaliseMemoryPath, scoreNavigation, siloOfPath } from "./memory-reads.js";
import type { TranscriptWireEvent } from "./transcript-read.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n += 1;
};

const SILO = "e2e-ambient-brain";

const call = (index: number, toolName: string, input: unknown): TranscriptWireEvent => ({
  index,
  at: `2026-01-18T01:00:${String(index).padStart(2, "0")}.000Z`,
  type: "actions.requested",
  data: { actions: [{ toolName, callId: `c${index}`, input }] },
});

const result = (index: number, toolName: string, output: string): TranscriptWireEvent => ({
  index,
  at: `2026-01-18T01:00:${String(index).padStart(2, "0")}.500Z`,
  type: "action.result",
  data: { turnId: "t1", stepIndex: 0, status: "completed", result: { callId: `c${index - 1}`, kind: "tool-result", toolName, output } },
});

{
  const events: TranscriptWireEvent[] = [
    { index: 0, at: "2026-01-23T01:00:00.000Z", type: "message.received", data: { message: `what is the OPE121 canary? look in memory/${SILO}/MEMORY.md` } },
    call(1, "read_file", { file_path: `/workspace/memory/${SILO}/MEMORY.md` }),
    result(2, "read_file", "# MEMORY\n- The OPE121 canary code is obsidian-50302\n"),
    call(3, "read_file", { file_path: `/workspace/memory/${SILO}/notes.md` }),
    result(4, "read_file", "- 2026-09-21: The OPE121 canary code is obsidian-50302\n"),
    { index: 5, at: "2026-01-23T01:00:05.000Z", type: "message.completed", data: { message: `it is obsidian-50302, from memory/${SILO}/MEMORY.md` } },
  ];
  const reads = extractMemoryPathReads(events);
  ok(reads.length === 2, `read_file transcript: both calls count (got ${reads.length}: ${reads.join(", ")})`);
  ok(
    reads[0] === `memory/${SILO}/MEMORY.md` && reads[1] === `memory/${SILO}/notes.md`,
    "read_file transcript: read order preserved and /workspace/ normalised away",
  );
  ok(siloOfPath(reads[0]!) === SILO, "read_file transcript: the read carries the silo the gate asserts on");

  const askOnly = extractMemoryPathReads([events[0]!]);
  ok(askOnly.length === 0, `the wake envelope's own path mention is never a read (got ${askOnly.length})`);

  const proseOnly = extractMemoryPathReads([events[5]!]);
  ok(proseOnly.length === 0, `an assistant message naming a memory path is never a read (got ${proseOnly.length})`);

  const cited = extractMemoryPathReads([
    call(1, "reply", { text: `The canary is obsidian-50302 — I read it from memory/${SILO}/MEMORY.md`, wake: "wake-1", done: true }),
  ]);
  ok(cited.length === 0, `🔴 a reply that CITES a memory file is never a read (got ${cited.join(", ")})`);
}

{
  const command = `grep -RIn --exclude='*.conflict-*' -E 'OPE121|ope121' /workspace/memory; echo done`;
  const output = [
    `/workspace/memory/${SILO}/MEMORY.md:2:- The OPE121 canary code is obsidian-50302`,
    `/workspace/memory/${SILO}/MEMORY.md:3:- (set 2026-09-21)`,
    `/workspace/memory/${SILO}/notes.md:74:- 2026-09-21: The OPE121 canary code is obsidian-50302`,
    "done",
  ].join("\n");
  const events: TranscriptWireEvent[] = [
    { index: 0, at: "2026-01-23T01:00:00.000Z", type: "message.received", data: { message: "what is the OPE121 canary code? check the files on disk" } },
    call(1, "bash", { command }),
    result(2, "bash", output),
    { index: 3, at: "2026-01-23T01:00:33.000Z", type: "message.completed", data: { message: "The current OPE121 canary code is exactly `obsidian-50302`." } },
  ];
  const reads = extractMemoryPathReads(events);
  ok(reads.length > 0, `🔴 OPE-2016: a recursive grep over the memory root COUNTS (today's code scored 0; got ${reads.length})`);

  const silos = [...new Set(reads.map(siloOfPath).filter((s): s is string => s !== null))];
  ok(silos.length === 1 && silos[0] === SILO, `🔴 OPE-2016: the grep's OUTPUT supplies the silo the second gate demands (got [${silos.join(", ")}])`);
  ok(
    reads.includes(`memory/${SILO}/MEMORY.md`) && reads.includes(`memory/${SILO}/notes.md`),
    `🔴 OPE-2016: both files the grep opened are in the trace (got ${reads.join(", ")})`,
  );
  ok(reads.includes("memory"), "the input's memory ROOT is counted as the navigation step it is");
  ok(siloOfPath("memory") === null, "…and a bare root touch carries NO silo, so it can never satisfy the silo gate on its own");

  ok(
    reads.filter((r) => r === `memory/${SILO}/MEMORY.md`).length === 1,
    `one result event contributes each distinct path once (got ${reads.filter((r) => r === `memory/${SILO}/MEMORY.md`).length})`,
  );

  const nav = scoreNavigation(reads, SILO, `memory/${SILO}/notes.md`);
  ok(nav.readsToHit === 2, `scoreNavigation finds the answer file third in the grep trace (readsToHit ${String(nav.readsToHit)}, trace ${reads.join(" → ")})`);
  ok(nav.rightSiloFirst, "…and the first SILO-carrying read is the right silo (the bare root carries none, so it cannot be the first silo)");
  ok(nav.crossSiloConfusion === false, "…and reports no cross-silo confusion for a single-silo trace");

  const elsewhere = extractMemoryPathReads([
    call(1, "bash", { command: "grep -RIn -E 'OPE121' /workspace/skills" }),
    result(2, "bash", "/workspace/skills/linear/SKILL.md:3:OPE121"),
  ]);
  ok(elsewhere.length === 0, `a grep that touches no memory path scores nothing (got ${elsewhere.length}: ${elsewhere.join(", ")})`);

  const wordOnly = extractMemoryPathReads([result(2, "bash", "out of memory; the memory was not read")]);
  ok(wordOnly.length === 0, `the English word "memory" is not a memory path (got ${wordOnly.join(", ")})`);
}

{
  const brief = `read /workspace/memory/${SILO}/MEMORY.md and report the OPE121 canary`;

  const dispatched = extractMemoryPathReads([call(1, "agent", { agentId: null, message: brief })]);
  ok(dispatched.length === 0, `🔴 eve's \`agent\` brief — under \`message\` — is never a read (got ${dispatched.join(", ")})`);

  const threaded = extractMemoryPathReads([call(1, "spawn_thread_session", { brief, thread: "1769606529.675000" })]);
  ok(threaded.length === 0, `\`spawn_thread_session\`'s brief — under \`brief\` — is never a read either (got ${threaded.join(", ")})`);

  const taskId = "agent-8af998";
  const report = `I read memory/${SILO}/MEMORY.md and the OPE121 canary is obsidian-50302`;
  const started: TranscriptWireEvent = {
    index: 2,
    at: "2026-01-23T01:00:02.000Z",
    type: "task.started",
    data: { callId: "c1", kind: "agent", name: "agent", taskId, turnId: "t1" },
  };
  const settled: TranscriptWireEvent = {
    index: 4,
    at: "2026-01-23T01:00:04.000Z",
    type: "task.settled",
    data: { callId: "c1", kind: "agent", name: "agent", output: report, status: "completed", taskId, turnId: "t1" },
  };
  ok(readTaskStarted(started.data)?.taskId === taskId, "the task.started fixture is a shape access/background-tasks.ts admits");
  ok(readTaskSettled(settled.data)?.status === "completed", "the task.settled fixture is a shape access/background-tasks.ts admits");

  const receipt = extractMemoryPathReads([
    started,
    {
      index: 3,
      at: "2026-01-23T01:00:02.500Z",
      type: "action.result",
      data: { status: "completed", result: { callId: "c1", kind: "tool-result", toolName: "agent", output: `Started task ${taskId}. Its result will arrive later.` } },
    },
  ]);
  ok(receipt.length === 0, `a dispatch receipt and its task.started carry no path, so they score nothing (got ${receipt.join(", ")})`);

  const reported = extractMemoryPathReads([settled]);
  ok(reported.length === 0, `🔴 the worker's REPORT on task.settled is never the seat's read (got ${reported.join(", ")})`);
  const reportedObject = extractMemoryPathReads([{ ...settled, data: { ...(settled.data as object), output: { text: report } } }]);
  ok(reportedObject.length === 0, `…and neither is the report when the output is an object (got ${reportedObject.join(", ")})`);
  const asToolResult = extractMemoryPathReads([result(5, "bash", report)]);
  ok(asToolResult.length === 1 && asToolResult[0] === `memory/${SILO}/MEMORY.md`, `…while the same text as a tool RESULT counts (got ${asToolResult.join(", ")})`);

  const echoed = extractMemoryPathReads([
    {
      index: 2,
      at: "2026-01-23T01:00:02.500Z",
      type: "action.result",
      data: { status: "completed", result: { callId: "c1", kind: "tool-result", toolName: "spawn_thread_session", output: { brief, seat: "wrun_x" } } },
    },
  ]);
  ok(echoed.length === 0, `…and a result that echoes the brief back does not count it (got ${echoed.join(", ")})`);
}

{
  const listing = extractMemoryPathReads([
    call(1, "bash", { command: "ls -R /workspace/memory" }),
    result(2, "bash", `/workspace/memory:\n${SILO}\n\n/workspace/memory/${SILO}:\nMEMORY.md\nnotes.md\n`),
  ]);
  ok(
    listing.length === 1 && listing[0] === "memory",
    `🔴 a recursive LISTING scores the root touch and nothing else — no silo, so the silo gate still reds (got ${listing.join(", ")})`,
  );
  ok(listing.map(siloOfPath).every((s) => s === null), "…and the trace carries no silo at all, which is what makes that red honest");

  const walked = extractMemoryPathReads([result(2, "bash", `/workspace/memory/${SILO}/MEMORY.md\n/workspace/memory/${SILO}/notes.md\n`)]);
  ok(walked.length === 2 && siloOfPath(walked[0]!) === SILO, `…while an output naming the FILES counts both (got ${walked.join(", ")})`);
}

{
  ok(normaliseMemoryPath("/workspace/memory") === "memory", "normaliseMemoryPath: the absolute root becomes the relative root");
  ok(normaliseMemoryPath("memory/") === "memory", "normaliseMemoryPath: a trailing slash is stripped");
  ok(normaliseMemoryPath(`/workspace/memory/${SILO}/MEMORY.md`) === `memory/${SILO}/MEMORY.md`, "normaliseMemoryPath: a silo path keeps every segment");
}

console.log(`✓ ${n} memory-reads assertions passed`);
