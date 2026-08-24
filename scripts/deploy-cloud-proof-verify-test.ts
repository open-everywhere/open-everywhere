import assert from "node:assert/strict";

import { extractEvidenceLines, parseEvidence } from "./deploy/cloud-proof-verify-lib.js";

let checks = 0;
const check = (label: string, fn: () => void): void => {
  checks++;
  fn();
};

const SHA = "abc1234";

check("extractEvidenceLines: matches a well-formed line and ignores narrative around it", () => {
  const text = ["Running suites...", `OE_PROOF sha=${SHA} suite=typecheck:all exit=0`, "typecheck:all passed in 12s", "All done!"].join("\n");
  const lines = extractEvidenceLines(text);
  assert.deepEqual(lines, [{ sha: SHA, name: "typecheck:all", exit: 0 }]);
});

check("extractEvidenceLines: a truncated line (cut mid-field) does not match", () => {
  const text = [`OE_PROOF sha=${SHA} suite=typecheck:all exit=0`, `OE_PROOF sha=${SHA} suite=test ex`].join("\n");
  const lines = extractEvidenceLines(text);
  assert.equal(lines.length, 1);
});

check("extractEvidenceLines: uppercase hex in sha does not match (spec is lowercase only)", () => {
  const lines = extractEvidenceLines(`OE_PROOF sha=ABC1234 suite=test exit=0`);
  assert.equal(lines.length, 0);
});

check("extractEvidenceLines: a negative exit code is still a valid integer match", () => {
  const lines = extractEvidenceLines(`OE_PROOF sha=${SHA} suite=killed exit=-1`);
  assert.deepEqual(lines, [{ sha: SHA, name: "killed", exit: -1 }]);
});

check("parseEvidence: an empty file is unparseable", () => {
  const v = parseEvidence("");
  assert.equal(v.verdict, "unparseable");
});

check("parseEvidence: ordinary log noise with no evidence line at all is unparseable", () => {
  const v = parseEvidence("Building...\nAll tests passed!\nDone.\n");
  assert.equal(v.verdict, "unparseable");
  if (v.verdict === "unparseable") assert.match(v.reason, /no OE_PROOF evidence lines/);
});

check("parseEvidence: a truncated evidence line (simulated cut-off upload) is unparseable, never pass", () => {
  const text = [`OE_PROOF sha=${SHA} suite=typecheck:all exit=0`, `OE_PROOF sha=${SHA} suite=test exit=0`, `OE_PROOF sha=${SHA} suite=build ex`].join("\n");
  const v = parseEvidence(text);
  assert.equal(v.verdict, "pass");
  if (v.verdict === "pass") assert.deepEqual(v.suites.map((s) => s.name).sort(), ["test", "typecheck:all"]);
});

check("parseEvidence: a file with ONLY a truncated line (no complete evidence at all) is unparseable", () => {
  const v = parseEvidence(`some log preamble\nOE_PROOF sha=${SHA} suite=build ex`);
  assert.equal(v.verdict, "unparseable");
});

check("parseEvidence: narrative claims all-green, but one EXIT line is non-zero → fail, never pass", () => {
  const text = [
    "=== Running full proof ===",
    "typecheck:all ... OK",
    `OE_PROOF sha=${SHA} suite=typecheck:all exit=0`,
    "test ... OK",
    `OE_PROOF sha=${SHA} suite=test exit=0`,
    "build ... OK",
    `OE_PROOF sha=${SHA} suite=build exit=1`,
    "✓ ALL SUITES PASSED — ready to ship!",
    "Summary: 3/3 green, zero failures, proof complete.",
  ].join("\n");
  const v = parseEvidence(text);
  assert.equal(v.verdict, "fail");
  if (v.verdict === "fail") {
    assert.deepEqual(v.failing, ["build"]);
    assert.equal(v.sha, SHA);
  }
});

check("parseEvidence: evidence lines naming two different shas → unparseable", () => {
  const v = parseEvidence([`OE_PROOF sha=${SHA} suite=test exit=0`, `OE_PROOF sha=deadbeef1 suite=test exit=0`].join("\n"));
  assert.equal(v.verdict, "unparseable");
  if (v.verdict === "unparseable") assert.match(v.reason, /disagree about which sha/);
});

check("parseEvidence: the same suite reported twice with different exit codes → unparseable", () => {
  const v = parseEvidence([`OE_PROOF sha=${SHA} suite=test exit=0`, `OE_PROOF sha=${SHA} suite=test exit=1`].join("\n"));
  assert.equal(v.verdict, "unparseable");
  if (v.verdict === "unparseable") assert.match(v.reason, /conflicting exit codes/);
});

check("parseEvidence: the same suite reported twice with the SAME exit code is not a conflict", () => {
  const v = parseEvidence([`OE_PROOF sha=${SHA} suite=test exit=0`, `OE_PROOF sha=${SHA} suite=test exit=0`].join("\n"));
  assert.equal(v.verdict, "pass");
});

check("parseEvidence: every suite green, one sha, at least one suite → pass", () => {
  const text = [
    `OE_PROOF sha=${SHA} suite=typecheck:all exit=0`,
    `OE_PROOF sha=${SHA} suite=test exit=0`,
    `OE_PROOF sha=${SHA} suite=build exit=0`,
    `OE_PROOF sha=${SHA} suite=test:integration exit=0`,
  ].join("\n");
  const v = parseEvidence(text);
  assert.equal(v.verdict, "pass");
  if (v.verdict === "pass") {
    assert.equal(v.sha, SHA);
    assert.equal(v.suites.length, 4);
    assert.ok(v.suites.every((s) => s.exit === 0));
  }
});

console.log(`✓ deploy-cloud-proof-verify: ${checks} check(s) passed (extraction, absent/truncated, adversarial narrative, conflicts, positive case — all offline)`);
