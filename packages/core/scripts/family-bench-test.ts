import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CandidateTurn,
  type FamilyCase,
  FAMILY_BENCH,
  MINEABLE_FAMILIES,
  caseHalfErrors,
  casePairErrors,
  familyBenchProvenanceErrors,
  rateByFamily,
  scoreCase,
} from "./eval/family-bench.js";
import { mineE2eLeg, mineSoakStep, renderCase, run, soakStepFailed } from "./eval/mine-family-case.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exitCode = 1;
    throw new Error(`family-bench: ${label}`);
  }
  passed++;
}

function threw(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

ok(FAMILY_BENCH.length > 0, "the bench holds at least one case");
ok(familyBenchProvenanceErrors().length === 0, `the shipped bench passes its provenance rules: ${familyBenchProvenanceErrors().join("; ")}`);

for (const c of FAMILY_BENCH) {
  const errors = casePairErrors(c);
  ok(errors.length === 0, `${c.id}: discriminates its own pair — ${errors.join("; ")}`);
  ok(scoreCase(c, c.observed) === "defect", `${c.id}: the recorded failure scores defect`);
  ok(scoreCase(c, c.corrected) === "clean", `${c.id}: the corrected turn scores clean`);
  ok(MINEABLE_FAMILIES.includes(c.family), `${c.id}: its family is one a transcript can be mined from`);
  ok(c.provenance.ticket !== null || c.provenance.anchor !== null, `${c.id}: names a ticket or a repo anchor`);
}

ok(
  FAMILY_BENCH.some((c) => !c.correctedIsAuthored),
  "at least one case's corrected turn is transcript-backed, not authored",
);

const wakeCase = FAMILY_BENCH.find((c) => c.id === "wake-engaged-thread-declined");
ok(wakeCase !== undefined, "the wake case is in the bench");
ok(
  scoreCase(wakeCase as FamilyCase, { text: "", facts: { reply_verb: "no_reply", no_reply_reason: "not_relevant", engagement_state: "not-participating" } }) === "clean",
  "wake: a decline on a thread the seat is NOT in is clean — the engagement join is what makes it a defect",
);
const toolCase = FAMILY_BENCH.find((c) => c.id === "tool-use-attachment-ref-is-a-filename");
ok(toolCase !== undefined, "the tool-use case is in the bench");
ok(
  scoreCase(toolCase as FamilyCase, { ...(toolCase as FamilyCase).observed, facts: { ...(toolCase as FamilyCase).observed.facts, tool: "post_message" } }) === "clean",
  "tool-use: the same unknown-attachment shape under another tool is not this case",
);

const template = FAMILY_BENCH[0];
ok(template !== undefined, "a template case exists");
const base = template as FamilyCase;

const noProvenance: FamilyCase = { ...base, id: "synthetic-no-provenance", provenance: { ...base.provenance, ticket: null, anchor: null } };
ok(
  familyBenchProvenanceErrors([noProvenance]).some((e) => e.includes("not a case")),
  "a case with no ticket and no anchor is refused",
);

const unmineable: FamilyCase = { ...base, id: "synthetic-harness", family: "harness" };
ok(
  familyBenchProvenanceErrors([unmineable]).some((e) => e.includes("no seat transcript")),
  "a case in a family that leaves no transcript is refused",
);

ok(
  familyBenchProvenanceErrors([base, { ...base }]).some((e) => e.includes("duplicate case id")),
  "two cases with one id are refused",
);

const noRun: FamilyCase = { ...base, id: "synthetic-no-run", provenance: { ...base.provenance, run: "  " } };
ok(
  familyBenchProvenanceErrors([noRun]).some((e) => e.includes("run and the leg")),
  "a case whose provenance names no run is refused",
);

const noExpected: FamilyCase = { ...base, id: "synthetic-no-expected", expected: "   " };
ok(
  familyBenchProvenanceErrors([noExpected]).some((e) => e.includes("no expected behaviour")),
  "a case with no expected behaviour is refused",
);
const noContext: FamilyCase = { ...base, id: "synthetic-no-context", context: "" };
ok(
  familyBenchProvenanceErrors([noContext]).some((e) => e.includes("no context")),
  "a case with no context is refused",
);

ok(familyBenchProvenanceErrors([base]).length === 0, "the unmodified template case passes every provenance rule");

const emptySignal: FamilyCase = { ...base, id: "synthetic-empty-signal", signal: { text: [], facts: {} } };
ok(
  threw(() => scoreCase(emptySignal, { text: "anything at all", facts: {} })).includes("empty signal"),
  "scoreCase refuses a signal that would fire on every turn",
);
ok(
  casePairErrors(emptySignal).some((e) => e.includes("empty signal")),
  "the pair check reports an empty signal as a bench error rather than crashing",
);

const loose: FamilyCase = { ...base, id: "synthetic-loose", signal: { text: [/./], facts: {} } };
ok(
  casePairErrors(loose).some((e) => e.includes("cannot tell the fix from the defect")),
  "a signal that fires on the corrected turn is reported",
);

for (const c of FAMILY_BENCH) {
  const errors = caseHalfErrors(c);
  ok(errors.length === 0, `${c.id}: every declared half of its signal discriminates — ${errors.join("; ")}`);
}

const decorated = FAMILY_BENCH.find((c) => c.signal.text.length > 0 && Object.keys(c.signal.facts).length > 0);
ok(decorated !== undefined, "the bench holds a case that declares both halves");
const loosenedText: FamilyCase = { ...(decorated as FamilyCase), id: "synthetic-decoration", signal: { text: [/./], facts: (decorated as FamilyCase).signal.facts } };
ok(
  caseHalfErrors(loosenedText).some((e) => e.includes("decoration")),
  "a text half loose enough to match the corrected turn is reported as decoration",
);
const emptiedFacts: FamilyCase = { ...(decorated as FamilyCase), id: "synthetic-weak-facts", signal: { text: (decorated as FamilyCase).signal.text, facts: { member_outcome: "never-set" } } };
ok(
  caseHalfErrors(emptiedFacts).some((e) => e.includes("does not fire on the recorded failure")),
  "a facts half that misses its own recorded failure is reported",
);
ok(caseHalfErrors(decorated as FamilyCase).length === 0, "the unmodified two-half case passes the half rule");

const onFailures = rateByFamily(FAMILY_BENCH, (c) => c.observed);
for (const [family, row] of onFailures) {
  ok(row.clean === 0, `${family}: every recorded failure reproduces (clean=${row.clean}/${row.total})`);
}
const onFixes = rateByFamily(FAMILY_BENCH, (c) => c.corrected);
for (const [family, row] of onFixes) {
  ok(row.clean === row.total, `${family}: every corrected turn is clean (clean=${row.clean}/${row.total})`);
}

const SOAK_LINES = [
  JSON.stringify({
    run: "soak-synthetic-1",
    step: 4,
    phase: 2,
    at: "2026-01-01T00:00:00.000Z",
    intent: "SENTINEL-INTENT ask the seat to confirm the stored note",
    sent: { text: "SENTINEL-SENT did you write that down?", target: "room-x" },
    expectation: "SENTINEL-EXPECT the reply states the note is stored",
    observed: { memory_write_rows: 0, replied: true },
    conduct: "pass",
    memberOutcome: "delivered",
    rationale: "SENTINEL-PASS-RATIONALE the seat confirmed the stored note",
    next: "",
  }),
  JSON.stringify({
    run: "soak-synthetic-1",
    step: 5,
    phase: 2,
    at: "2026-01-01T00:01:00.000Z",
    intent: "SENTINEL-INTENT-5 ask again after the write",
    sent: { text: "SENTINEL-SENT-5 is it saved?", target: "room-x" },
    expectation: "SENTINEL-EXPECT-5 the reply states the note is stored",
    observed: { memory_write_rows: 0, replied: true },
    conduct: "hard-fail",
    memberOutcome: "broken",
    rationale: "SENTINEL-FAIL-RATIONALE the seat said it is saving the note and would confirm later",
    next: "",
  }),
  "{ truncated tail line",
].join("\n");

const mined5 = mineSoakStep(SOAK_LINES, 5);
ok(mined5.source === "soak", "a soak line mines as soak evidence");
ok(mined5.run === "soak-synthetic-1", "the mined case carries the run id");
ok(mined5.leg === "step 5 (phase 2)", `the mined case names the step and phase (got ${mined5.leg})`);
ok(mined5.turn.text.includes("SENTINEL-FAIL-RATIONALE"), "the failed step's own words are carried");
ok(mined5.turn.facts["memory_write_rows"] === 0, "the observed map's scalar facts are carried");
ok(mined5.turn.facts["conduct"] === "hard-fail", "the conduct is carried as a fact");
ok(mined5.turn.facts["member_outcome"] === "broken", "the member outcome is carried as a fact");
ok(mined5.context.includes("SENTINEL-EXPECT-5"), "the pre-send expectation is carried into the context");
ok(!mined5.turn.text.includes("SENTINEL-PASS-RATIONALE"), "a neighbouring step's words never enter the case");
ok(mined5.context.includes("SENTINEL-SENT-5"), "the sent text is carried into the context");

ok(threw(() => mineSoakStep(SOAK_LINES, 4)).includes("did not fail"), "a step that passed is refused, and the reason says so");
ok(threw(() => mineSoakStep(SOAK_LINES, 99)).includes("no soak verdict line"), "an absent step is refused as absent, not as a pass");
ok(threw(() => mineSoakStep(SOAK_LINES, 5)) === "", "the failed step itself does not throw");

ok(soakStepFailed({ conduct: "soft-fail" }), "a soft-fail is a failed turn");
ok(soakStepFailed({ conduct: "pass", memberOutcome: "broken" }), "`broken` is the failed member outcome");
ok(!soakStepFailed({ conduct: "pass", memberOutcome: "none" }), "`none` is the OPERATOR-only outcome, never a failure");
ok(!soakStepFailed({ conduct: "pass", memberOutcome: "delivered" }), "a pass that delivered to the member is not a failed turn");
ok(!soakStepFailed({ conduct: "pass", memberOutcome: "degraded" }), "`degraded` is not a failure — the driver's conduct decides that step");

const E2E_LOG = [
  "✓ S1 sentinel green scenario: passed (2 gates, 0 judged, 12.0s)",
  "✗ S-SENTINEL-TIMEOUT sentinel timeout scenario (180.4s): timed out after 180000ms waiting for a substantive bot reply in thread 1700159720.000100",
  "✗ S-SENTINEL-JUDGE sentinel judged scenario (41.2s): reply quality — judge: SENTINEL-JUDGE-DETAIL the reply announces work",
  "    ↳ reply: SENTINEL-REPLY-BODY I have started the check and will paste the output once it returns",
  "✗ S-SENTINEL-BUDGET sentinel budget scenario (301.0s): scenario exceeded its 300000ms budget",
  "✗ S-SENTINEL-EMPTY sentinel empty-reply scenario (42.0s): a gate failed",
  "    ↳ reply: <empty>",
  "– S-SENTINEL-SKIP sentinel skipped scenario: skipped (filtered by --only)",
].join("\n");

const timeout = mineE2eLeg(E2E_LOG, "S-SENTINEL-TIMEOUT");
ok(timeout.source === "e2e", "an e2e log line mines as e2e evidence");
ok(timeout.turn.facts["member_outcome"] === "none", "a reply timeout mines as member_outcome none");
ok(timeout.turn.facts["reply_rows"] === 0, "a reply timeout mines as zero reply rows");
ok(timeout.turn.facts["within_budget"] === false, "a reply timeout mines as out of budget");
ok(timeout.turn.text.includes("timed out after 180000ms"), "the timeout's own message is the record");

const judged = mineE2eLeg(E2E_LOG, "S-SENTINEL-JUDGE");
ok(judged.turn.text.includes("SENTINEL-REPLY-BODY"), "the ↳ reply tail becomes the turn's words");
ok(judged.turn.facts["member_outcome"] === "answered", "a leg with a reply mines as answered");
ok(judged.turn.facts["within_budget"] === true, "a leg that did not time out mines as within budget");
ok(!judged.turn.text.includes("timed out after 180000ms"), "a judged red never absorbs the timeout leg's message");
ok(!timeout.turn.text.includes("SENTINEL-REPLY-BODY"), "the timeout leg never absorbs the next leg's reply tail");
ok(judged.context.includes("41.2"), "the leg's measured duration reaches the context");

const budget = mineE2eLeg(E2E_LOG, "S-SENTINEL-BUDGET");
ok(budget.turn.facts["member_outcome"] === "none", "a blown scenario budget mines as member_outcome none");
ok(budget.turn.facts["reply_rows"] === 0, "a blown scenario budget mines as zero reply rows");
ok(budget.turn.facts["within_budget"] === false, "a blown scenario budget mines as out of budget");
const deliveryCase = FAMILY_BENCH.find((c) => c.family === "delivery");
ok(deliveryCase !== undefined, "the bench holds a delivery case");
ok(scoreCase(deliveryCase as FamilyCase, budget.turn) === "defect", "the delivery case fires on a blown-budget leg");

const emptyReply = mineE2eLeg(E2E_LOG, "S-SENTINEL-EMPTY");
ok(emptyReply.turn.text !== "<empty>", "the literal <empty> marker never becomes the turn's words");
ok(emptyReply.turn.facts["member_outcome"] === "none", "an <empty> reply tail mines as member_outcome none");
ok(emptyReply.turn.facts["reply_rows"] === 0, "an <empty> reply tail mines as zero reply rows");
ok(scoreCase(deliveryCase as FamilyCase, emptyReply.turn) === "defect", "the delivery case fires on an <empty> reply");
ok(scoreCase(deliveryCase as FamilyCase, judged.turn) === "clean", "a leg with real reply words does not fire the delivery case");

ok(threw(() => mineE2eLeg(E2E_LOG, "S1")).includes("did not fail"), "a green leg is refused, and the reason says it passed");
ok(threw(() => mineE2eLeg(E2E_LOG, "S-NOPE")).includes("no e2e failure line"), "an unknown leg is refused as absent");
ok(threw(() => mineE2eLeg(E2E_LOG, "S-SENTINEL-SKIP")).includes("did not fail"), "a skipped leg is refused as not-failed");

const rendered = renderCase(judged, "grounding", "synthetic-rendered");
ok(rendered.includes('id: "synthetic-rendered"'), "the rendered case carries the id it was given");
ok(rendered.includes('family: "grounding"'), "the rendered case carries the family");
ok(rendered.includes("SENTINEL-REPLY-BODY"), "the rendered case carries the mined turn's words");
ok(rendered.includes("signal: { text: [], facts: {} }"), "the rendered case's signal is EMPTY — the miner never writes the judgement");
ok(rendered.includes("ticket: null"), "the rendered case leaves the ticket for a human to name");
ok(rendered.includes('expected: ""'), "the rendered case leaves the expectation for a human to write");

const tmp = mkdtempSync(join(tmpdir(), "family-bench-"));
const soakPath = join(tmp, "verdicts.jsonl");
const e2ePath = join(tmp, "e2e.log");
writeFileSync(soakPath, SOAK_LINES);
writeFileSync(e2ePath, E2E_LOG);

const badFamily = run(["--evidence", soakPath, "--family", "lifecycle", "--step", "5"]);
ok(badFamily.code === 2, "a family with no transcript exits non-zero");
ok(badFamily.out.includes("leaves no seat transcript"), "…and the message names the rule, not just the family");

const unknownFamily = run(["--evidence", soakPath, "--family", "not-a-family", "--step", "5"]);
ok(unknownFamily.code === 2, "an unknown family exits non-zero");
ok(unknownFamily.out.includes("is not a failure family"), "…and the message lists the families");

const missingArgs = run(["--evidence", soakPath, "--family", "grounding"]);
ok(missingArgs.code === 2 && missingArgs.out.startsWith("usage:"), "naming neither a leg nor a step prints the usage");

const bothFlags = run(["--evidence", soakPath, "--family", "grounding", "--step", "5", "--leg", "J-GH"]);
ok(bothFlags.code === 2 && bothFlags.out.includes("never both"), "naming a leg AND a step is refused — the two select different files");

const badStep = run(["--evidence", soakPath, "--family", "grounding", "--step", "five"]);
ok(badStep.code === 2 && badStep.out.includes("must be a step number"), "a non-numeric step is refused by name");

const unreadable = run(["--evidence", join(tmp, "nope.jsonl"), "--family", "grounding", "--step", "5"]);
ok(unreadable.code === 2 && unreadable.out.includes("cannot read"), "an unreadable evidence file is refused by name");

const goodSoak = run(["--evidence", soakPath, "--family", "grounding", "--step", "5"]);
ok(goodSoak.code === 0, "a mineable family on a failed step exits 0");
ok(goodSoak.out.includes("SENTINEL-FAIL-RATIONALE"), "…and emits the case");

const asJson = run(["--evidence", e2ePath, "--family", "delivery", "--leg", "S-SENTINEL-TIMEOUT", "--json"]);
ok(asJson.code === 0, "--json exits 0");
const parsed = JSON.parse(asJson.out) as { family: string; text: string; facts: Record<string, unknown> };
ok(parsed.family === "delivery", "--json carries the family");
ok(parsed.facts["member_outcome"] === "none", "--json carries the mined facts");

const BENCH = join(HERE, "eval", "family-bench.ts");
const TSX_CLI = join(HERE, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");

const self = spawnSync(process.execPath, [TSX_CLI, BENCH, "--self-check"], { encoding: "utf8" });
ok(self.status === 0, `family-bench.ts --self-check exits 0 (got ${self.status}): ${self.stderr}`);
ok(self.stdout.includes("discriminate their own pair"), "…and says so");

const scorePath = join(tmp, "turn.json");
writeFileSync(scorePath, asJson.out);
const scored = spawnSync(process.execPath, [TSX_CLI, BENCH, "--score", scorePath], { encoding: "utf8" });
ok(scored.status === 0, `family-bench.ts --score exits 0 (got ${scored.status}): ${scored.stderr}`);
ok(scored.stdout.includes("delivery-reply-timeout-member-got-nothing [delivery]: defect"), "a mined timeout reproduces the delivery case");

const cleanTurn: CandidateTurn = { text: "here is the answer", facts: { member_outcome: "answered", reply_rows: 1 } };
writeFileSync(scorePath, JSON.stringify({ family: "delivery", ...cleanTurn }));
const scoredClean = spawnSync(process.execPath, [TSX_CLI, BENCH, "--score", scorePath], { encoding: "utf8" });
ok(scoredClean.status === 0, `family-bench.ts --score exits 0 on a clean turn (got ${scoredClean.status})`);
ok(scoredClean.stdout.includes("delivery-reply-timeout-member-got-nothing [delivery]: clean"), "a turn that answered does NOT reproduce the delivery case");

console.log(`✓ family bench + miner: ${passed} assertions`);
