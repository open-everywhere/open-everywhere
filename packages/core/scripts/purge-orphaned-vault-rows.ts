import { appendAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { sweepOrphanedVaultRows, orphanSweepHolders, type SweepReport } from "./purge-orphaned-vault-rows-lib.js";
import { wireNeonOperationalStore } from "./e2e/rotate-window-lib.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usage(message: string): never {
  console.error(message);
  console.error("usage: purge-orphaned-vault-rows.ts --org <id> [--apply] [--actor <who>] [--local-store] [--verbose]");
  process.exit(2);
}

const org = arg("org");
const apply = flag("apply");
const verbose = flag("verbose");
const localStore = flag("local-store");
const actor = arg("actor") ?? "operator:purge-orphaned-vault-rows";
const dbUrl = process.env.DATABASE_URL;

if (!org) usage("--org is required (the org whose stored_credential rows are swept).");
if (localStore && dbUrl) usage("--local-store and DATABASE_URL are mutually exclusive — unset one so it is unambiguous WHICH database is being swept.");
if (!localStore && !dbUrl) usage("DATABASE_URL is required (a live Postgres connection string), or pass --local-store to sweep the ambient self-host store.");

const store = localStore ? getOperationalStore() : await wireNeonOperationalStore(dbUrl!);

console.log("\nOrphaned per-person vault rows (OPE-349 — the OPE-309 phase-1 re-key residue)");
console.log(`Store:   ${store.id}${localStore ? " (ambient / self-host floor)" : " (hosted postgres via DATABASE_URL)"}`);
console.log(`Org:     ${org}`);
console.log(`Holders: ${orphanSweepHolders().join(", ")}`);
console.log(`Mode:    ${apply ? "APPLY — matched rows will be DESTROYED and audited" : "DRY RUN — nothing will be written (pass --apply to destroy)"}`);
console.log("─".repeat(96));

let report: SweepReport;
try {
  report = await sweepOrphanedVaultRows({ store, org, apply, actor, audit: appendAudit });
} catch (e) {
  console.error("SWEEP FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

for (const row of report.rows) {
  const v = row.verdict;
  if (v.kind === "orphan") {
    console.log(`  ${row.deleted ? "✗ DELETED " : apply ? "· already gone" : "→ WOULD DELETE"}  [${v.holder}] ${row.ref}`);
    console.log(`      subject ${v.subject}  (platform ${v.platform}, native id ${v.nativeId})`);
  } else if (v.kind === "skip") {
    console.log(`  ? SKIPPED    ${row.ref}`);
    console.log(`      ${v.reason}`);
  } else if (verbose) {
    console.log(`  · kept       ${row.ref}${v.kind === "current" ? `  (composable today: ${v.subject})` : "  (not person-keyed)"}`);
  }
}

console.log("  " + "─".repeat(60));
console.log(`  scanned:           ${report.scanned}`);
console.log(`  matched (orphans): ${report.matched}`);
console.log(`  deleted:           ${report.deleted}${apply ? "" : "   (dry run — nothing was written)"}`);
console.log(`  skipped-ambiguous: ${report.skipped}`);
console.log(`  left alone:        ${report.current} composable today, ${report.notSubjectKeyed} not person-keyed`);
for (const [holder, t] of Object.entries(report.byHolder)) {
  console.log(`    ${holder}: ${t.matched} matched, ${t.deleted} deleted`);
}
if (report.skipped > 0) {
  console.log(`\n  ${report.skipped} row(s) were recognised as person-keyed but NOT classified with confidence, and were left in place.`);
  console.log("  That is the intended posture — a wrongly-kept row is dead weight, a wrongly-deleted one is somebody's live credential.");
}
if (!apply && report.matched > 0) {
  console.log(`\n  Re-run with --apply to destroy the ${report.matched} matched row(s). Each deletion writes an "identity.credential.orphan_purged" audit row.`);
}
console.log();
process.exit(0);
