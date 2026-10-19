import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, noteFor, parseUpgradingNotes } from "../packages/core/scripts/upgrade-notes.js";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";
import {
  CONTRACT_FILE,
  GENERATED_FILES,
  GENERATORS,
  LOCK_FILE,
  PACKAGE_INFO_FILE,
  PATCH_SUMMARY,
  PatchRefusal,
  RECORD_FILE,
  ROSTER_LOCK_FILE,
  commitMessage,
  generateWith,
  nextPatch,
  planPatch,
  runPatch,
  type PatchPlan,
  type RunOptions,
} from "./release-patch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATE = "2026-10-19";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function refusal(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (err) {
    if (err instanceof PatchRefusal) return err.code;
    throw err;
  }
}

const READS = [...ALL_PUBLISHABLE_PACKAGES.map((d) => `${d}/package.json`), LOCK_FILE, PACKAGE_INFO_FILE, CONTRACT_FILE, ROSTER_LOCK_FILE, RECORD_FILE];
const rawTree = new Map(READS.map((p) => [p, readFileSync(join(ROOT, p), "utf8")]));
const FROM = String(JSON.parse(rawTree.get("packages/core/package.json")!).version);
const tree = (() => {
  const record = JSON.parse(rawTree.get(RECORD_FILE)!) as { releases: { version: string }[] };
  record.releases = record.releases.filter((r) => compareVersions(r.version, FROM) <= 0);
  return new Map(rawTree).set(RECORD_FILE, `${JSON.stringify(record, null, 2)}\n`);
})();
const TO = nextPatch(FROM);

type Json = Record<string, any>;
function withJson(path: string, edit: (j: Json) => void, base: ReadonlyMap<string, string> = tree): Map<string, string> {
  const j = JSON.parse(base.get(path)!) as Json;
  edit(j);
  return new Map(base).set(path, `${JSON.stringify(j, null, 2)}\n`);
}
const reader = (files: ReadonlyMap<string, string>) => (path: string): string => {
  const text = files.get(path);
  if (text === undefined) throw new Error(`the fixture has no ${path}`);
  return text;
};
const plan = (files: ReadonlyMap<string, string> = tree, date = DATE): PatchPlan => planPatch(reader(files), date);
function changedLines(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return -1;
  return a.filter((line, i) => line !== b[i]).length;
}
const withDraft = (draft: Json): Map<string, string> => withJson(RECORD_FILE, (j) => j.releases.unshift(draft));
const emptyDraft = (version: string): Json => ({
  version,
  date: "2026-10-21",
  summary: "Draft.",
  evePeer: "0.71.0",
  breaking: [],
  configMigrations: [],
  env: { added: [], removed: [] },
  manualSteps: [],
  removedFiles: [],
  newDefaults: [],
});

ok(nextPatch("0.8.0") === "0.8.1" && nextPatch("1.2.9") === "1.2.10", "the next patch adds one to the third number, as a number");
ok(refusal(() => nextPatch("0.9.0-rc.1")) === "not-semver", "🔴 a prerelease version is refused");

const clean = plan();
ok(refusal(() => plan()) === "none", "this tree plans clean — the negative control for every refusal below");
ok(clean.from === FROM && clean.to === TO, `the plan bumps ${FROM} to ${TO}`);
ok(JSON.stringify([...plan().writes]) === JSON.stringify([...clean.writes]), "two plans of one tree on one date are byte-identical (the written bytes are deterministic)");
ok(refusal(() => plan(tree, "19/10/2026")) === "usage", "a date that is not YYYY-MM-DD is refused");

const record = parseUpgradingNotes(JSON.parse(clean.writes.get(RECORD_FILE)!));
const entry = record.notes === undefined ? undefined : noteFor(record.notes, TO);
const corePeer = String(JSON.parse(tree.get("packages/core/package.json")!).peerDependencies.eve);
ok(record.notes !== undefined && record.notes.releases[0]?.version === TO, "the new entry parses and sits at the top of the newest-first record");
ok(entry?.date === DATE && entry.summary === PATCH_SUMMARY && entry.evePeer === corePeer, "the entry is dated, has the patch summary, and records core's eve peer");
ok(
  entry !== undefined &&
    entry.breaking.length + entry.configMigrations.length + entry.env.added.length + entry.env.removed.length + entry.manualSteps.length + entry.removedFiles.length + entry.newDefaults.length === 0,
  "every list of the entry is empty",
);
ok(record.notes?.releases.length === parseUpgradingNotes(JSON.parse(tree.get(RECORD_FILE)!)).notes!.releases.length + 1, "the bump adds one entry and drops none");

ok(refusal(() => plan(withJson("packages/providers/email/package.json", (j) => (j.version = TO)))) === "lockstep", "🔴 eleven packages that do not carry one version are refused");
ok(
  refusal(() => plan(withJson("packages/create/package.json", (j) => (j.dependencies["@open-everywhere/core"] = `^${FROM}`)))) === "sibling-pin",
  "🔴 a sibling pin that is not the exact lockstep version is refused",
);
ok(
  refusal(() => plan(withJson("packages/create/package.json", (j) => (j.dependencies["@open-everywhere/ghost"] = FROM)))) === "unknown-sibling",
  "a pin on an `@open-everywhere/*` name that does not publish is refused",
);
ok(
  refusal(() => plan(withJson(LOCK_FILE, (j) => (j.packages["packages/core"].version = TO)))) === "drift",
  "🔴 a lock whose workspace entry is not at the manifests' version is refused",
);
ok(refusal(() => plan(withJson(ROSTER_LOCK_FILE, (j) => (j.packages["@open-everywhere/core"].version = "0.0.1")))) === "drift", "a roster lock at another version is refused");
ok(
  refusal(() => plan(new Map(tree).set(PACKAGE_INFO_FILE, tree.get(PACKAGE_INFO_FILE)!.replace(`"${FROM}"`, '"0.0.1"')))) === "drift",
  "🔴 a CORE_PACKAGE_VERSION that drifted from the manifests is refused",
);
ok(
  refusal(() => plan(new Map(tree).set(CONTRACT_FILE, `${tree.get(CONTRACT_FILE)!}\n"core": "${FROM}"\n`))) === "drift",
  "a contract page with two core version lines is refused, not guessed",
);

const lockBefore = JSON.parse(tree.get(LOCK_FILE)!) as Json;
const lockAfter = JSON.parse(clean.writes.get(LOCK_FILE)!) as Json;
ok(JSON.stringify(lockAfter.packages[""]) === JSON.stringify(lockBefore.packages[""]), "the lock's root entry, with its 0.1.0 sentinel pins, does not change");

for (const field of ["breaking", "configMigrations", "env", "manualSteps", "removedFiles", "newDefaults"] as const) {
  const draft = emptyDraft(TO);
  if (field === "env") draft.env = { added: [], removed: ["OE_OLD"] };
  else if (field === "configMigrations") draft.configMigrations = [{ description: "Rename a key." }];
  else if (field === "removedFiles") draft.removedFiles = ["agent/old.ts"];
  else draft[field] = ["A line."];
  ok(refusal(() => plan(withDraft(draft))) === "draft-has-notes", `🔴 a draft entry with a \`${field}\` line is refused: that release needs notes`);
}
const taken = plan(withDraft(emptyDraft(TO)));
const takenNotes = parseUpgradingNotes(JSON.parse(taken.writes.get(RECORD_FILE)!)).notes!;
ok(
  taken.tookOverDraft && takenNotes.releases[0]!.version === TO && takenNotes.releases[0]!.date === DATE && takenNotes.releases[0]!.summary === "Draft.",
  "an empty draft for the next patch is taken over: dated today, its summary kept (the negative control for the draft refusals)",
);
ok(takenNotes.releases.filter((r) => r.version === TO).length === 1, "…and it is replaced, not duplicated");
ok(!clean.tookOverDraft, "a tree with no draft takes nothing over");
const minor = FROM.replace(/^(\d+)\.(\d+)\..*$/u, (_, a: string, b: string) => `${a}.${Number(b) + 1}.0`);
ok(refusal(() => plan(withDraft(emptyDraft(minor)))) === "draft-other-version", `🔴 an empty draft for another version (${minor}) is refused: it names a release this is not`);
ok(refusal(() => plan(withJson(RECORD_FILE, (j) => j.releases.shift()))) === "record", "a record with no entry for the current version is refused");
ok(refusal(() => plan(withJson(RECORD_FILE, (j) => j.releases.reverse()))) === "record", "a record that does not parse (oldest first) is refused");
ok(refusal(() => plan(withJson("packages/core/package.json", (j) => delete j.peerDependencies.eve))) === "record", "a core with no `eve` peer is refused: the entry has no evePeer to record");
ok(refusal(() => plan(new Map(tree).set(LOCK_FILE, "{ not json"))) === "unreadable", "a file that is not JSON is refused");
ok(
  refusal(() => plan(new Map(tree).set(CONTRACT_FILE, tree.get(CONTRACT_FILE)!.replace(`"core": "${FROM}"`, "")))) === "drift",
  "a contract page with no core version line is refused",
);

function scratch(files: ReadonlyMap<string, string> = tree): string {
  const root = mkdtempSync(join(tmpdir(), "oe-release-patch-"));
  for (const [path, text] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const path of GENERATED_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "generated\n");
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}
const IDENTITY = ["-c", "user.name=release-patch-test", "-c", "user.email=release-patch-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd: root, encoding: "utf8" });
}
const generated = (root: string): void => {
  for (const path of GENERATED_FILES) writeFileSync(join(root, path), "regenerated\n");
};
const options = (root: string, over: Partial<RunOptions> = {}): RunOptions => ({
  root,
  date: DATE,
  dryRun: false,
  commit: true,
  surfaceGate: () => true,
  generate: generated,
  git,
  log: () => {},
  ...over,
});
const head = (root: string): string => git(root, ["rev-parse", "HEAD"]).trim();
const status = (root: string): string => git(root, ["status", "--porcelain"]).trim();

{
  const root = scratch();
  const before = head(root);
  ok(refusal(() => runPatch(options(root, { surfaceGate: () => false }))) === "upgrade-surface", "🔴 a red `test:upgrade-surface` is refused");
  ok(head(root) === before && status(root) === "", "…and the refusal writes nothing and commits nothing");

  runPatch(options(root, { dryRun: true }));
  ok(head(root) === before && status(root) === "", "a dry run writes nothing and commits nothing");

  writeFileSync(join(root, "stray.txt"), "x\n");
  ok(refusal(() => runPatch(options(root))) === "dirty-tree", "🔴 a dirty tree is refused, so the bump commit holds the bump only");
  ok(head(root) === before, "…and the refusal commits nothing");
}
{
  const root = scratch();
  const p = runPatch(options(root));
  const files = git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
  ok(status(root) === "", "the bump leaves a clean tree");
  ok(git(root, ["log", "--format=%s", "-1"]).trim() === commitMessage(p), "the bump is one commit with the fixed message");
  ok(/^Signed-off-by: /mu.test(git(root, ["log", "--format=%B", "-1"])), "the bump commit carries the DCO sign-off");
  ok(JSON.stringify(files) === JSON.stringify([...p.writes.keys(), ...GENERATED_FILES].sort()), "the commit holds exactly the planned writes and the two generated files");
  ok(readFileSync(join(root, LOCK_FILE), "utf8") === p.writes.get(LOCK_FILE), "the written bytes are the planned bytes");
}
{
  const root = scratch();
  const before = head(root);
  const strayGenerator = (r: string): void => {
    generated(r);
    writeFileSync(join(r, "packages", "core", "surprise.ts"), "x\n");
  };
  ok(refusal(() => runPatch(options(root, { generate: strayGenerator }))) === "stray-write", "🔴 a generator that writes outside the bump is refused");
  ok(head(root) === before, "…and nothing is committed");
}
{
  const root = scratch();
  const before = head(root);
  for (const bad of GENERATORS) {
    const ran: string[] = [];
    const generate = generateWith((script) => {
      ran.push(script);
      return script !== bad;
    });
    ok(refusal(() => runPatch(options(root, { generate }))) === "generate", `🔴 a failing ${bad} is refused`);
    ok(head(root) === before, "…and nothing is committed");
    ok(ran[ran.length - 1] === bad, "…and no generator after it runs");
    git(root, ["checkout", "--quiet", "--", "."]);
  }
  const ran: string[] = [];
  ok(refusal(generateWith((script) => (ran.push(script), true))) === "none", "two generators that pass are clean (the negative control)");
  ok(JSON.stringify(ran) === JSON.stringify(["scripts/docs-generate.ts", "scripts/upgrading-notes-generate.ts"]), "…and both run, the docs embed first, then UPGRADING.md");
}
{
  const root = scratch();
  runPatch(options(root, { commit: false }));
  ok(head(root) === git(root, ["rev-list", "--max-parents=0", "HEAD"]).trim() && status(root) !== "", "--no-commit writes the bump and makes no commit");
}

const live = (() => {
  try {
    return planPatch((path) => readFileSync(join(ROOT, path), "utf8"), DATE);
  } catch (err) {
    if (err instanceof PatchRefusal && (err.code === "draft-has-notes" || err.code === "draft-other-version")) return err;
    throw err;
  }
})();
if (live instanceof PatchRefusal) {
  console.log(`· tier 2: this tree's record has a draft entry, so a patch is refused, as it must be (${live.message})`);
} else {
  const manifests = ALL_PUBLISHABLE_PACKAGES.map((d) => `${d}/package.json`);
  ok(manifests.every((m) => live.writes.has(m)) && ALL_PUBLISHABLE_PACKAGES.length === 11, "tier 2: all eleven manifests are written");
  let pins = 0;
  for (const m of manifests) {
    const before = readFileSync(join(ROOT, m), "utf8");
    const deps = JSON.parse(before) as Json;
    const own = Object.keys({ ...deps.dependencies, ...deps.devDependencies, ...deps.peerDependencies, ...deps.optionalDependencies }).filter((n) => n.startsWith("@open-everywhere/")).length;
    pins += own;
    ok(changedLines(before, live.writes.get(m)!) === 1 + own, `tier 2: ${m} changes its version and its ${own} sibling pin(s), nothing else`);
  }
  ok(changedLines(tree.get(LOCK_FILE)!, live.writes.get(LOCK_FILE)!) === 11 + pins, `tier 2: ${LOCK_FILE} changes ${11 + pins} lines, one for each manifest version and sibling pin (the 0.8.0 bump changed 22)`);
  ok(changedLines(tree.get(PACKAGE_INFO_FILE)!, live.writes.get(PACKAGE_INFO_FILE)!) === 1, `tier 2: ${PACKAGE_INFO_FILE} changes one line`);
  ok(changedLines(tree.get(CONTRACT_FILE)!, live.writes.get(CONTRACT_FILE)!) === 1, `tier 2: ${CONTRACT_FILE} changes one line`);
  const rosterNames = Object.keys((JSON.parse(tree.get(ROSTER_LOCK_FILE)!) as Json).packages).filter((n) => n.startsWith("@open-everywhere/")).length;
  ok(rosterNames > 0 && changedLines(tree.get(ROSTER_LOCK_FILE)!, live.writes.get(ROSTER_LOCK_FILE)!) === rosterNames, `tier 2: ${ROSTER_LOCK_FILE} changes its ${rosterNames} version lines only`);
  ok(live.writes.size === manifests.length + 5, "tier 2: the plan writes the manifests and five more files, no other");
}

console.log(`✓ release:patch: ${passed} assertions — ${FROM} → ${TO}.`);
