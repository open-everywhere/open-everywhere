import {
  fillReportWakePlaceholder,
  unresolvedReportWakePlaceholderFault,
  wakeIdFromReport,
  WAKE_FROM_REPORT,
} from "../agent/model/scripted-model.js";
import { SETTLEMENT_WAKE_LINE_PREFIX, settlementWakeLine } from "@open-everywhere/core/agent/instructions/seat-prompt.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WAKE_A: string = "00000000-0000-4000-8000-000000000064";
const WAKE_B: string = "00000000-0000-4000-8000-000000000065";

function msg(text: string): { readonly text: string } {
  return { text };
}

{
  ok(settlementWakeLine(WAKE_A) === `for wake ${WAKE_A}`, "the settlement line is `for wake <id>`");
  ok(SETTLEMENT_WAKE_LINE_PREFIX === "for wake ", "…and the prefix the scanner keys on is that same literal");
}

{
  const found = wakeIdFromReport([msg(`PR #165 is green and merged.\n\n${settlementWakeLine(WAKE_A)}`)]);
  ok(found === WAKE_A, "a report whose last line names a wake resolves that wake");
  const trailing = wakeIdFromReport([msg(`done\n${settlementWakeLine(WAKE_A)}  \n`)]);
  ok(trailing === WAKE_A, "…and trailing spaces on that line do not defeat the scan");
}

{
  const seatSentence = `The report tells you which one: its last line reads \`${SETTLEMENT_WAKE_LINE_PREFIX}<wake-id>\`, and that is the \`wake-id\` your \`reply\` names.`;
  ok(wakeIdFromReport([msg(seatSentence)]) === undefined, "🔴 the seat persona's mid-sentence quote of the shape resolves NOTHING");
  ok(
    wakeIdFromReport([msg(seatSentence), msg(`done\n${settlementWakeLine(WAKE_A)}`)]) === WAKE_A,
    "🔴 …and a real report in the same prompt still resolves, so the guard rejects the quote rather than the whole prompt",
  );
  ok(wakeIdFromReport([msg(`${SETTLEMENT_WAKE_LINE_PREFIX}<wake-id>`)]) === undefined, "🔴 a bracketed placeholder alone on a line is still not an address");
}

{
  ok(wakeIdFromReport([]) === undefined, "an empty prompt resolves nothing");
  ok(wakeIdFromReport([msg("no report here"), msg("nor here")]) === undefined, "a prompt with no report line resolves nothing");
  ok(wakeIdFromReport([msg(`I finished; ${settlementWakeLine(WAKE_A)} is the thread.`)]) === undefined, "🔴 an address buried mid-line is not an address");
}

{
  const both = wakeIdFromReport([msg(`old\n${settlementWakeLine(WAKE_B)}`), msg(`new\n${settlementWakeLine(WAKE_A)}`)]);
  ok(both === WAKE_A, "two reports in one prompt resolve the NEWEST");
  ok(WAKE_A !== WAKE_B, "negative control: the two fixture ids really differ, so the assertion above picked one");
}

{
  const filled = fillReportWakePlaceholder({ wake: WAKE_FROM_REPORT, text: "hi", done: true }, WAKE_A);
  ok(!filled.unresolved, "a fill with a known id is resolved");
  ok(JSON.stringify(filled.value) === JSON.stringify({ wake: WAKE_A, text: "hi", done: true }), "…and it replaces only the placeholder");

  const unresolved = fillReportWakePlaceholder({ wake: WAKE_FROM_REPORT }, undefined);
  ok(unresolved.unresolved, "🔴 a fill with NO id is unresolved — which is the fault the responder records");
  ok(JSON.stringify(unresolved.value) === JSON.stringify({ wake: WAKE_FROM_REPORT }), "…and the value is left alone rather than half-written");

  const untouched = { wake: WAKE_A, text: "hi" };
  ok(fillReportWakePlaceholder(untouched, WAKE_A).value === untouched, "a call with no placeholder is returned unchanged, by identity");
  ok(fillReportWakePlaceholder(undefined, WAKE_A).unresolved === false, "an input-less call is never a fault");

  const said = fillReportWakePlaceholder(`done\n\nfor wake ${WAKE_FROM_REPORT}`, WAKE_A);
  ok(said.value === `done\n\n${settlementWakeLine(WAKE_A)}`, "🔴 a terminal-text report fills to a line the scanner can then read back");
  ok(wakeIdFromReport([msg(String(said.value))]) === WAKE_A, "🔴 …round-trip: what the worker says is what the seat resolves");
}

{
  const fault = unresolvedReportWakePlaceholderFault("reply");
  ok(fault.includes(WAKE_FROM_REPORT), "the fault names the placeholder that could not be filled");
  ok(fault.includes("OPE-2133"), "…and the ticket whose regression it is");
  ok(!fault.includes("<wake wake-id="), "🔴 …and NOT the envelope fault's copy — two defects, two messages");
}

console.log(`✓ scripted-report-address: ${passed} assertions passed`);
