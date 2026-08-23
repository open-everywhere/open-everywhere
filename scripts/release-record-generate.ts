import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitDateAt, evePinAt, oeVersionAt, providerPackagesAt } from "./release-record/derive.js";
import { parseReleaseRecord, type ReleaseChange, type ReleaseMigration, type ReleaseRecord } from "./release-record/schema.js";
import { listReleaseRecordDirs, loadReleaseRecord } from "./release-record/store.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function resolveSha(ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
}

function latestExistingSha(): string | undefined {
  const dirs = listReleaseRecordDirs();
  let best: { sha: string; date: string } | undefined;
  for (const dir of dirs) {
    const loaded = loadReleaseRecord(dir);
    if (!loaded.record) continue;
    if (!best || loaded.record.date > best.date) best = { sha: loaded.record.sha, date: loaded.record.date };
  }
  return best?.sha;
}

const toSha = resolveSha(flag("to") ?? "HEAD");
const fromArg = flag("from");
const fromSha = fromArg ? resolveSha(fromArg) : latestExistingSha();
if (!fromSha) {
  console.error("✗ release-record:generate: no --from given and no existing releases/*/migration.json to default from.");
  console.error("  Pass --from <sha> explicitly (this is expected for the very first record).");
  process.exit(2);
}

const outDir = flag("out") ?? join("releases", toSha);
const outPath = join(outDir, "migration.json");

const changes: ReleaseChange[] = [];
const migrations: ReleaseMigration[] = [];

const oeFrom = oeVersionAt(fromSha);
const oeTo = oeVersionAt(toSha);
if (oeFrom !== undefined && oeTo !== undefined && oeFrom !== oeTo) {
  changes.push({ unit: "oeVersion", summary: `Open Everywhere package version ${oeFrom} -> ${oeTo}.`, derived: true });
}

const eveFrom = evePinAt(fromSha);
const eveTo = evePinAt(toSha);
if (eveFrom !== undefined && eveTo !== undefined && eveFrom !== eveTo) {
  changes.push({ unit: "evePin", summary: `eve framework pin ${eveFrom} -> ${eveTo}.`, derived: true });
  migrations.push({
    id: "rotate-windows-after-eve-bump",
    unit: "evePin",
    required: true,
    backwardsCompatible: true,
    description: "Rotate every seat window. An eve version bump changes the runtime under every open window; rotation rows are per seat, never per surface.",
    derived: true,
  });
}

const providersFrom = new Set(providerPackagesAt(fromSha));
const providersTo = providerPackagesAt(toSha);
for (const name of providersTo) {
  if (!providersFrom.has(name)) {
    changes.push({ unit: "provider", summary: `New provider package: packages/providers/${name}.`, derived: true });
  }
}

if (changes.length === 0) {
  console.error(`✗ release-record:generate: nothing derivable changed between ${fromSha} and ${toSha} (OE version, eve pin, provider packages all match).`);
  console.error("  If this release is config-only, write releases/<sha>/migration.json by hand — this generator has nothing to contribute.");
  process.exit(1);
}

let summary = changes.map((c) => c.summary).join(" ");
let verify: string[] = ["deploy:verify", "deploy:census", "deploy:smoke"];
let rollback: ReleaseRecord["rollback"] = { command: "rollback" };
let handChanges: ReleaseChange[] = [];
let handMigrations: ReleaseMigration[] = [];

if (existsSync(outPath)) {
  const raw = JSON.parse(readFileSync(outPath, "utf8"));
  const { record } = parseReleaseRecord(raw, outPath);
  if (record) {
    summary = record.summary;
    verify = [...record.verify];
    rollback = record.rollback;
    handChanges = record.changes.filter((c) => !c.derived);
    handMigrations = record.migrations.filter((m) => !m.derived);
  } else {
    console.error(`⚠ release-record:generate: ${outPath} exists but does not currently validate — regenerating its derived fields only, hand-authored content could not be recovered.`);
  }
}

const record: ReleaseRecord = {
  formatVersion: 1,
  sha: toSha,
  previousSha: fromSha,
  date: commitDateAt(toSha),
  summary,
  changes: [...changes, ...handChanges],
  migrations: [...migrations, ...handMigrations],
  verify,
  rollback,
};

const { problems } = parseReleaseRecord(record, outPath);
if (problems.length > 0) {
  console.error(`✗ release-record:generate: the record this generator produced does not validate itself — this is a bug in the generator, not in your inputs.`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log(`✓ wrote ${outPath}`);
console.log(`  ${changes.length} derived change(s), ${migrations.length} derived migration(s). Review before committing — add any "config"-unit changes by hand.`);
