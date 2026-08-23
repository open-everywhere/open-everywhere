import { readFileSync } from "node:fs";
import { buildUpgradeContext } from "./release-record/context.js";
import { parseReleaseRecord, type ReleaseRecord } from "./release-record/schema.js";
import { loadAllReleaseRecords } from "./release-record/store.js";
import { structuralProblems } from "./release-record/structural.js";

const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);

function makeRecord(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    formatVersion: 1,
    sha: "a".repeat(40),
    previousSha: null,
    date: "2026-08-01",
    summary: "Test record.",
    changes: [{ unit: "provider", summary: "New provider.", derived: true }],
    migrations: [],
    verify: ["deploy:verify"],
    rollback: { command: "rollback" },
    ...overrides,
  };
}

{
  const { record, problems: p } = parseReleaseRecord(makeRecord(), "fixture");
  if (!record || p.length > 0) fail(`schema: a well-formed record should validate with zero problems — got ${JSON.stringify(p)}`);
}
{
  const { record, problems: p } = parseReleaseRecord({ ...makeRecord(), changes: [] }, "fixture");
  if (record || p.length === 0) fail("schema: an empty changes array must be refused (a release that changed nothing is not a release)");
}
{
  const { record, problems: p } = parseReleaseRecord({ ...makeRecord(), sha: "not-a-sha" }, "fixture");
  if (record || p.length === 0) fail("schema: a non-hex sha must be refused");
}
{
  const dup = { id: "x", unit: "config", required: true, backwardsCompatible: true, description: "d", derived: false };
  const { record, problems: p } = parseReleaseRecord({ ...makeRecord(), migrations: [dup, dup] }, "fixture");
  if (record || p.length === 0) fail("schema: duplicate migration ids within one record must be refused");
}

const knownScripts = new Set(["deploy:verify", "deploy:census", "deploy:smoke", "rollback"]);
{
  const clean = makeRecord({ sha: "b".repeat(40) });
  const p = structuralProblems("b".repeat(40), clean, knownScripts);
  if (p.length > 0) fail(`structural: a clean record should have zero problems — got ${JSON.stringify(p)}`);
}
{
  const record = makeRecord({ sha: "b".repeat(40) });
  const p = structuralProblems("c".repeat(40), record, knownScripts);
  if (p.length === 0) fail("structural: sha not matching its own directory name must be flagged");
}
{
  const record = makeRecord({
    sha: "d".repeat(40),
    changes: [{ unit: "evePin", summary: "eve 0.1 -> 0.2", derived: true }],
    migrations: [],
  });
  const p = structuralProblems("d".repeat(40), record, knownScripts);
  if (!p.some((m) => /window/i.test(m))) fail("structural: an evePin change with no window-rotation migration must be flagged (this is the derivation->consequence rule)");
}
{
  const record = makeRecord({
    sha: "e".repeat(40),
    changes: [{ unit: "evePin", summary: "eve 0.1 -> 0.2", derived: true }],
    migrations: [{ id: "rot", unit: "evePin", required: true, backwardsCompatible: true, description: "Rotate every window.", derived: true }],
  });
  const p = structuralProblems("e".repeat(40), record, knownScripts);
  if (p.length > 0) fail(`structural: an evePin change WITH a rotation migration should be clean — got ${JSON.stringify(p)}`);
}
{
  const record = makeRecord({
    sha: "f".repeat(40),
    migrations: [{ id: "m1", unit: "config", required: true, backwardsCompatible: false, description: "Irreversible thing.", derived: false }],
    rollback: { command: "rollback" },
  });
  const p = structuralProblems("f".repeat(40), record, knownScripts);
  if (!p.some((m) => /rollback.notes/.test(m))) fail("structural: a non-backwards-compatible migration with no rollback.notes must be flagged");
}
{
  const record = makeRecord({ sha: "0".repeat(40), verify: ["not-a-real-script"] });
  const p = structuralProblems("0".repeat(40), record, knownScripts);
  if (!p.some((m) => /not-a-real-script/.test(m))) fail("structural: a verify entry naming an unknown npm script must be flagged");
}

const A = "1".repeat(40);
const B = "2".repeat(40);
const C = "3".repeat(40);
const recA_to_B = makeRecord({
  sha: B,
  previousSha: A,
  changes: [{ unit: "provider", summary: "Change B.", derived: true }],
  verify: ["deploy:verify"],
  rollback: { command: "rollback", notes: "rollback-B" },
});
const recB_to_C = makeRecord({
  sha: C,
  previousSha: B,
  changes: [{ unit: "config", summary: "Change C.", derived: false }],
  verify: ["deploy:census"],
  rollback: { command: "rollback", notes: "rollback-C" },
});

{
  const ctx = buildUpgradeContext([recA_to_B, recB_to_C], A, C);
  if (!ctx.reached) fail("context: a two-hop chain from A to C should reach C");
  if (ctx.toSha !== C) fail(`context: toSha should be C — got ${ctx.toSha}`);
  if (ctx.changes.length !== 2) fail(`context: should aggregate both hops' changes — got ${ctx.changes.length}`);
  if (ctx.verify.join(",") !== "deploy:verify,deploy:census") fail(`context: verify should union both hops in order — got ${ctx.verify.join(",")}`);
  if (ctx.rollback.notes !== "rollback-C") fail(`context: rollback should be the LAST hop's, not the first — got ${JSON.stringify(ctx.rollback)}`);
}
{
  const ctx = buildUpgradeContext([recA_to_B, recB_to_C], C);
  if (ctx.toSha !== C || ctx.changes.length !== 0) fail("context: a sha with no known continuation must report itself as toSha with zero aggregated changes, not throw");
}
{
  const unknownTarget = "9".repeat(40);
  const ctx = buildUpgradeContext([recA_to_B, recB_to_C], A, unknownTarget);
  if (ctx.reached) fail("context: an unreachable target must report reached:false");
  if (ctx.toSha !== C) fail(`context: an unreachable target should still report the FURTHEST known hop (C) — got ${ctx.toSha}`);
}
{
  const forkedSibling = makeRecord({ sha: "4".repeat(40), previousSha: A });
  const original = makeRecord({ sha: B, previousSha: A });
  let threw = false;
  try {
    buildUpgradeContext([forkedSibling, original], A);
  } catch {
    threw = true;
  }
  if (!threw) fail("context: two records both claiming the same previousSha must throw (an unresolvable fork), not silently resolve");
}

{
  const realKnownScripts = new Set(Object.keys((JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}));
  const loaded = loadAllReleaseRecords();
  if (loaded.length === 0) fail("real-data: expected at least one shipped releases/*/migration.json — OPE-993 ships one as proof of format");
  for (const l of loaded) {
    if (l.problems.length > 0) fail(`real-data: releases/${l.dirName} failed schema validation: ${JSON.stringify(l.problems)}`);
    else if (l.record) {
      const p = structuralProblems(l.dirName, l.record, realKnownScripts);
      if (p.length > 0) fail(`real-data: releases/${l.dirName} failed structural checks: ${JSON.stringify(p)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ release-record: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("✓ release-record: schema + structural invariants + consumption-walk aggregation, dedup, honest-unreachable and fork detection all hold; shipped record(s) validate cleanly");
