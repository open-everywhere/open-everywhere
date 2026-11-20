import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fillTaskPlaceholder,
  taskIdFromPrompt,
  taskIdFromReceipt,
  taskResultDeliveryCount,
  taskResultsInPrompt,
  unresolvedTaskPlaceholderFault,
  TASK_FROM_RECEIPT,
} from "../agent/model/scripted-model.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function msg(text: string): { readonly text: string } {
  return { text };
}

const RENDER_MODULE = join(process.cwd(), "node_modules", "eve", "dist", "src", "execution", "tasks", "render.js");
let render: {
  readonly renderTaskReceipt?: (task: { readonly id: string; readonly resumable: boolean; readonly tool: string }) => string;
  readonly renderTaskSentReceipt?: (taskId: string) => string;
  readonly renderTaskResults?: (
    results: readonly { readonly body: string; readonly status: "completed" | "failed"; readonly taskId: string; readonly tool: string }[],
  ) => string;
  readonly TASK_SYSTEM_BLOCK?: string;
};
try {
  render = (await import(pathToFileURL(RENDER_MODULE).href)) as typeof render;
} catch (err) {
  console.error(
    `✗ eve's task renderers are gone from ${RENDER_MODULE} — an eve bump moved them. This file is the ` +
      "tripwire for agent/model/scripted-model.ts's readers of that prose: find the new home, re-point this " +
      "import, and re-derive those readers against it. Do NOT replace the import with a literal fixture — a " +
      "copied string is exactly what this file exists to avoid.",
  );
  console.error(err);
  process.exit(1);
}

for (const name of ["renderTaskReceipt", "renderTaskSentReceipt", "renderTaskResults", "TASK_SYSTEM_BLOCK"] as const) {
  ok(
    render[name] !== undefined,
    `🔴 TRIPWIRE: eve still exports ${name} from execution/tasks/render.js — the prose agent/model/scripted-model.ts reads`,
  );
}
const renderTaskReceipt = render.renderTaskReceipt as NonNullable<typeof render.renderTaskReceipt>;
const renderTaskSentReceipt = render.renderTaskSentReceipt as NonNullable<typeof render.renderTaskSentReceipt>;
const renderTaskResults = render.renderTaskResults as NonNullable<typeof render.renderTaskResults>;

const TASK_A = "agent-d0x4n2";
const TASK_B = "agent-ytjkdc";

for (const resumable of [true, false]) {
  const receipt = renderTaskReceipt({ id: TASK_A, resumable, tool: "agent" });
  ok(
    taskIdFromReceipt(receipt) === TASK_A,
    `① the id is read off eve's own ${resumable ? "resumable" : "one-shot"} receipt — got ${String(taskIdFromReceipt(receipt))} from ${JSON.stringify(receipt)}`,
  );
}

ok(taskIdFromReceipt(renderTaskSentReceipt(TASK_A)) === TASK_A, "① the id is read off eve's own continuation receipt");

ok(taskIdFromReceipt({ taskId: TASK_B }) === TASK_B, "② a 0.54-style `{ taskId }` object still reads");

for (const [label, value] of [
  ["prose that is not a receipt", "I started working on it."],
  ["an empty string", ""],
  ["an object with no taskId", { status: "completed" }],
  ["an object with an empty taskId", { taskId: "" }],
  ["undefined", undefined],
  ["a number", 7],
] as const) {
  ok(taskIdFromReceipt(value) === undefined, `③ ${label} reads as undefined, not as a guessed id`);
}

const systemBlock = render.TASK_SYSTEM_BLOCK as string;
ok(systemBlock.includes("<task_result"), "④ eve's system block really does carry the bare tag — the collision is real, not hypothetical");
ok(taskResultDeliveryCount([msg(systemBlock)]) === 0, "④ eve's own system block counts as ZERO deliveries");
ok(taskResultsInPrompt([msg(systemBlock)]).length === 0, "④ eve's own system block yields NO result blocks");

const oneResult = renderTaskResults([{ body: "the worker's prose", status: "completed", taskId: TASK_A, tool: "agent" }]);
const read = taskResultsInPrompt([msg(systemBlock), msg(oneResult)]);
ok(read.length === 1, `⑤ one rendered result reads back as one block — got ${read.length}`);
ok(read[0]?.taskId === TASK_A, "⑤ …with eve's own task id");
ok(read[0]?.tool === "agent", "⑤ …and eve's own tool name");
ok(read[0]?.status === "completed", "⑤ …and eve's own status");

const failed = renderTaskResults([{ body: "it broke", status: "failed", taskId: TASK_B, tool: "agent" }]);
ok(taskResultsInPrompt([msg(failed)])[0]?.status === "failed", "⑤ a FAILED result reads back as failed — a caller must not read it as completed");

const bothTogether = renderTaskResults([
  { body: "first", status: "completed", taskId: TASK_A, tool: "agent" },
  { body: "second", status: "completed", taskId: TASK_B, tool: "agent" },
]);
ok(taskResultsInPrompt([msg(bothTogether)]).length === 2, "⑥ two results rendered together are TWO blocks");
ok(taskResultDeliveryCount([msg(bothTogether)]) === 1, "⑥ …and ONE delivery, because they resumed the turn once");
ok(taskResultDeliveryCount([msg(oneResult), msg(failed)]) === 2, "⑥ two separate messages are TWO deliveries");

const cumulative = [
  msg(systemBlock),
  msg(renderTaskReceipt({ id: TASK_A, resumable: true, tool: "agent" })),
  msg("some backscroll in between"),
  msg(renderTaskReceipt({ id: TASK_B, resumable: true, tool: "agent" })),
];
ok(taskIdFromPrompt(cumulative) === TASK_B, `⑦ the LAST receipt wins — got ${String(taskIdFromPrompt(cumulative))}`);
ok(taskIdFromPrompt([msg(systemBlock)]) === undefined, "⑦ a prompt with no receipt answers undefined");

const filled = fillTaskPlaceholder({ taskId: TASK_FROM_RECEIPT }, TASK_A);
ok((filled.value as { taskId: string }).taskId === TASK_A, "⑧ the placeholder is replaced by the prompt's own id");
ok(!filled.unresolved, "⑧ …and the fill is marked resolved");
const unfilled = fillTaskPlaceholder({ taskId: TASK_FROM_RECEIPT }, undefined);
ok(unfilled.unresolved, "⑧ a prompt with no receipt leaves the placeholder UNRESOLVED, so the call is never emitted");
ok((unfilled.value as { taskId: string }).taskId === TASK_FROM_RECEIPT, "⑧ …and the placeholder is left verbatim for the record");
ok(
  unresolvedTaskPlaceholderFault("eve__task_cancel").includes(TASK_FROM_RECEIPT),
  "⑧ the fault names the placeholder it could not resolve",
);
ok(
  unresolvedTaskPlaceholderFault("eve__task_cancel").includes("AFTER the step whose call started the task"),
  "⑧ …and names the script-order mistake that causes it",
);
const untouched = { taskId: "literal-id" };
ok(fillTaskPlaceholder(untouched, TASK_A).value === untouched, "⑧ a call with no placeholder is returned unrebuilt");

console.log(`scripted-task-receipt: ${passed} assertions passed (eve's own renderers drove every one)`);
