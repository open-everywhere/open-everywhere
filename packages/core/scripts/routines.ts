import { listAllRoutines, routinesRoot } from "../agent/routines/store.js";
import { isDue } from "../agent/routines/schedule.js";
import { describeTrigger } from "../agent/routines/routine.js";

const onlyDue = process.argv.includes("--due");
const now = new Date();

const all = await listAllRoutines();
const rows = onlyDue ? all.filter((r) => r.status === "active" && isDue(r.nextRunAt, now)) : all;

console.log(`\nRoutine store: ${routinesRoot()}`);
console.log(`${all.length} routine(s) total${onlyDue ? `, ${rows.length} due now` : ""}`);
console.log("─".repeat(70));

if (rows.length === 0) {
  console.log(onlyDue ? "  (nothing due)" : "  (no routines yet)");
} else {
  for (const r of rows) {
    const flags = [r.status, r.lastOutcome ? `last=${r.lastOutcome}` : null, r.consecutiveFailures ? `fails=${r.consecutiveFailures}` : null]
      .filter(Boolean)
      .join(" ");
    console.log(`\n  ${r.id}  [${r.surfaceKey}]  ${flags}`);
    console.log(`    trigger : ${describeTrigger(r.trigger, r.report)}`);
    console.log(`    next    : ${r.nextRunAt ?? "(event-driven)"}`);
    console.log(`    do      : ${r.prompt.slice(0, 100)}${r.prompt.length > 100 ? "…" : ""}`);
    if (r.disabledReason) console.log(`    note    : ${r.disabledReason}`);
  }
}
console.log();
