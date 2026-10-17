import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { finishedRun, tsxCommand } from "./npm-command.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collapseShardSeries, extractEvidenceLines, incompleteShardTiers, parseEvidence } from "./deploy/cloud-proof-verify-lib.js";

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

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
const mainRun = (sha = FULL_SHA): string[] => [`OE_PROOF sha=${sha} suite=typecheck:all exit=0`, `OE_PROOF sha=${sha} suite=test exit=0`, `OE_PROOF sha=${sha} suite=build exit=0`];
const shardLine = (k: number, n: number, exit = 0, sha = FULL_SHA): string => `OE_PROOF sha=${sha} suite=test:integration--shard=${k}/${n} exit=${exit}`;
const series = (n: number): string[] => Array.from({ length: n }, (_, i) => shardLine(i + 1, n));

check("parseEvidence: a COMPLETE all-green shard series on one sha passes, and collapses to the tier", () => {
  const text = [...mainRun(), "shard run 3 transcript…", shardLine(3, 4), shardLine(1, 4), shardLine(4, 4), shardLine(2, 4)].join("\n");
  const v = parseEvidence(text);
  assert.equal(v.verdict, "pass", JSON.stringify(v));
  const coverage = collapseShardSeries(v.suites);
  assert.ok(coverage.names.has("test:integration"), "the complete series proves the tier");
  assert.deepEqual(coverage.series, [{ tier: "test:integration", shards: 4 }]);
  assert.ok(coverage.summary.includes("test:integration=0 (4 shards)"), coverage.summary);
});

check("parseEvidence: a one-shard series (OE_IT_SHARD=1/1) is a complete series", () => {
  assert.equal(parseEvidence([...mainRun(), shardLine(1, 1)].join("\n")).verdict, "pass");
});

check("parseEvidence: 🔴 a PARTIAL green series is refused — part of a tier proves nothing about the tier", () => {
  const v = parseEvidence([...mainRun(), shardLine(1, 4), shardLine(2, 4), shardLine(4, 4)].join("\n"));
  assert.equal(v.verdict, "unparseable", "three green shards of four must never verify pass");
  if (v.verdict === "unparseable") assert.ok(/incomplete shard series for test:integration/.test(v.reason), v.reason);
  assert.equal(parseEvidence([...mainRun(), shardLine(2, 4)].join("\n")).verdict, "unparseable", "one lone shard is refused");
  assert.equal(parseEvidence(shardLine(1, 4)).verdict, "unparseable", "a single-shard run's own transcript proves no tier on its own");
});

check("parseEvidence: 🔴 a series that mixes two Ns is refused, even when every k of each is present", () => {
  const v = parseEvidence([...mainRun(), ...series(3), ...series(4)].join("\n"));
  assert.equal(v.verdict, "unparseable", "two splits are not one split known to cover the tier");
  const mixed = parseEvidence([...mainRun(), shardLine(1, 2), shardLine(2, 3)].join("\n"));
  assert.equal(mixed.verdict, "unparseable");
});

check("parseEvidence: 🔴 a shard index outside 1..N is refused, even beside a count that adds up", () => {
  assert.equal(parseEvidence([...mainRun(), shardLine(1, 2), shardLine(3, 2)].join("\n")).verdict, "unparseable");
  assert.equal(parseEvidence([...mainRun(), shardLine(0, 2), shardLine(1, 2)].join("\n")).verdict, "unparseable");
});

check("parseEvidence: 🔴 shards from two shas are refused, never joined into one tier", () => {
  const other = "fedcba9876543210fedcba9876543210fedcba98";
  const v = parseEvidence([...mainRun(), shardLine(1, 2), shardLine(2, 2, 0, other)].join("\n"));
  assert.equal(v.verdict, "unparseable");
});

check("parseEvidence: 🔴 one red shard is a red tier — fail, and never collapsed into a green tier name", () => {
  const v = parseEvidence([...mainRun(), shardLine(1, 4), shardLine(2, 4, 137), shardLine(3, 4), shardLine(4, 4)].join("\n"));
  assert.equal(v.verdict, "fail");
  if (v.verdict === "fail") assert.deepEqual(v.failing, ["test:integration--shard=2/4"]);
  assert.equal(collapseShardSeries(v.suites).names.has("test:integration"), false, "a red series never proves the tier");
  assert.equal(parseEvidence([...mainRun(), shardLine(2, 4, 1)].join("\n")).verdict, "fail");
});

check("parseEvidence: a tier reported directly is not refused because stray shard lines sit beside it", () => {
  const v = parseEvidence([...mainRun(), `OE_PROOF sha=${FULL_SHA} suite=test:integration exit=0`, shardLine(2, 4)].join("\n"));
  assert.equal(v.verdict, "pass", "the tier's own line proves the tier; a shard line beside it takes nothing away");
  assert.deepEqual(incompleteShardTiers(v.suites), []);
});

check("collapseShardSeries: each completeness condition is load-bearing (the cases that moved out of this file)", () => {
  const green = (names: string[]) => names.map((name) => ({ name, exit: 0 }));
  const shards = (n: number, ks: number[]) => ks.map((k) => `test:integration--shard=${k}/${n}`);
  assert.ok(collapseShardSeries(green(shards(4, [1, 2, 3, 4]))).names.has("test:integration"), "complete → the tier");
  assert.equal(collapseShardSeries(green(shards(4, [1, 2, 4]))).names.has("test:integration"), false, "a missing k → no tier");
  assert.equal(collapseShardSeries(green([...shards(4, [1, 2, 3]), ...shards(3, [3])])).names.has("test:integration"), false, "two Ns → no tier");
  assert.equal(
    collapseShardSeries([...green(shards(2, [1])), { name: "test:integration--shard=2/2", exit: 1 }]).names.has("test:integration"),
    false,
    "a red shard → no tier",
  );
  const partial = collapseShardSeries(green(shards(4, [1, 3])));
  assert.ok(partial.names.has("test:integration--shard=1/4") && partial.names.has("test:integration--shard=3/4"), "an incomplete series keeps its literal shard names");
  assert.deepEqual(incompleteShardTiers(green(shards(4, [1, 3]))), ["test:integration"]);
});

check("deploy:cloud-proof-verify CLI: exit 0 on a complete fanned-out series, exit 1 on a partial one", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "oe-cloud-proof-verify-"));
  try {
    const run = (lines: string[]): number => {
      const file = join(dir, "evidence.txt");
      writeFileSync(file, lines.join("\n"));
      return finishedRun(spawnSync(...tsxCommand(root, [join(root, "scripts", "deploy", "cloud-proof-verify.ts"), file]), { encoding: "utf8" }), "cloud-proof-verify.ts").status;
    };
    assert.equal(run([...mainRun(), ...series(4)]), 0, "a complete green series verifies pass");
    assert.equal(run([...mainRun(), ...series(4).slice(0, 3)]), 1, "🔴 a partial series exits 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`✓ deploy-cloud-proof-verify: ${checks} check(s) passed (extraction, absent/truncated, adversarial narrative, conflicts, positive case, shard series — all offline)`);
