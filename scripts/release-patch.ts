import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareVersions, NOTES_FILE, noteFor, PAGE_FILE, parseUpgradingNotes } from "../packages/core/scripts/upgrade-notes.js";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LOCK_FILE = "package-lock.json";
export const ROSTER_LOCK_FILE = "roster.lock.json";
export const PACKAGE_INFO_FILE = "packages/core/agent/ops/package-info.ts";
export const CONTRACT_FILE = "docs/deploy/contract.md";
export const RECORD_FILE = `packages/core/${NOTES_FILE}`;
export const GENERATED_FILES = [`packages/core/${PAGE_FILE}`, "packages/core/agent/docs/generated/deploy.ts"] as const;

export const PATCH_SUMMARY = "A patch release. It needs no upgrade step.";

const STEP_FIELDS = ["breaking", "configMigrations", "env", "manualSteps", "removedFiles", "newDefaults"] as const;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const SCOPE = "@open-everywhere/";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export class PatchRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PatchPlan {
  readonly from: string;
  readonly to: string;
  readonly date: string;
  readonly writes: ReadonlyMap<string, string>;
  readonly tookOverDraft: boolean;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const jsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function parseJson(read: (path: string) => string, path: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(read(path));
  } catch (err) {
    throw new PatchRefusal("unreadable", `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!isRecord(value)) throw new PatchRefusal("unreadable", `${path}: expected a JSON object at the top level.`);
  return value;
}

export function nextPatch(version: string): string {
  const m = SEMVER.exec(version);
  if (m === null) throw new PatchRefusal("not-semver", `the packages are at "${version}", which is not a plain x.y.z version. A patch bump starts from a released version.`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function replaceOne(text: string, path: string, pattern: RegExp, from: string, to: string, what: string): string {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new PatchRefusal("drift", `${path} holds ${matches.length} ${what} line(s). The bump expects exactly one.`);
  const [whole, version] = matches[0]!;
  if (version !== from) throw new PatchRefusal("drift", `${path} says ${what} "${version}" and the packages are at "${from}". Fix the drift first.`);
  return text.replace(whole, whole.replace(`"${from}"`, `"${to}"`));
}

function bumpSiblingPins(entry: Json, path: string, from: string, to: string, publishable: ReadonlySet<string>): void {
  for (const field of DEP_FIELDS) {
    const deps = entry[field];
    if (!isRecord(deps)) continue;
    for (const [name, pin] of Object.entries(deps)) {
      if (!name.startsWith(SCOPE)) continue;
      if (!publishable.has(name)) throw new PatchRefusal("unknown-sibling", `${path} ${field} names ${name}, which is not one of the publishable packages.`);
      if (pin !== from) throw new PatchRefusal("sibling-pin", `${path} ${field} pins ${name} at "${String(pin)}". Every sibling pin must be the lockstep version "${from}".`);
      deps[name] = to;
    }
  }
}

export function planPatch(read: (path: string) => string, date: string): PatchPlan {
  if (!DATE.test(date)) throw new PatchRefusal("usage", `the date "${date}" is not YYYY-MM-DD.`);
  const writes = new Map<string, string>();

  const manifests = ALL_PUBLISHABLE_PACKAGES.map((dir) => ({ dir, path: `${dir}/package.json`, json: parseJson(read, `${dir}/package.json`) }));
  const versions = new Set(manifests.map((m) => String(m.json.version)));
  if (versions.size !== 1) {
    const list = manifests.map((m) => `${String(m.json.name)}@${String(m.json.version)}`).join(", ");
    throw new PatchRefusal("lockstep", `the ${manifests.length} publishable packages do not carry one version: ${list}. Bring them into lockstep first.`);
  }
  const from = [...versions][0]!;
  const to = nextPatch(from);
  const publishable = new Set(manifests.map((m) => String(m.json.name)));
  for (const m of manifests) {
    m.json.version = to;
    bumpSiblingPins(m.json, m.path, from, to, publishable);
    writes.set(m.path, jsonText(m.json));
  }

  const lock = parseJson(read, LOCK_FILE);
  const lockPackages = isRecord(lock.packages) ? lock.packages : {};
  for (const m of manifests) {
    const entry = lockPackages[m.dir];
    if (!isRecord(entry) || entry.version !== from) {
      throw new PatchRefusal("drift", `${LOCK_FILE} has no "${m.dir}" entry at "${from}". Run \`npm install\` so the lock matches the manifests, then bump.`);
    }
    entry.version = to;
    bumpSiblingPins(entry, `${LOCK_FILE} "${m.dir}"`, from, to, publishable);
  }
  writes.set(LOCK_FILE, jsonText(lock));

  writes.set(PACKAGE_INFO_FILE, replaceOne(read(PACKAGE_INFO_FILE), PACKAGE_INFO_FILE, /export const CORE_PACKAGE_VERSION = "([^"]*)";/gu, from, to, "CORE_PACKAGE_VERSION"));
  writes.set(CONTRACT_FILE, replaceOne(read(CONTRACT_FILE), CONTRACT_FILE, /"core": "([^"]*)"/gu, from, to, 'the "core" version'));

  const roster = parseJson(read, ROSTER_LOCK_FILE);
  const rosterPackages = isRecord(roster.packages) ? roster.packages : {};
  for (const [name, entry] of Object.entries(rosterPackages)) {
    if (!publishable.has(name) || !isRecord(entry)) continue;
    if (entry.version !== from) throw new PatchRefusal("drift", `${ROSTER_LOCK_FILE} has ${name} at "${String(entry.version)}" and the packages are at "${from}". Run \`npx oe build --accept\` first.`);
    entry.version = to;
  }
  writes.set(ROSTER_LOCK_FILE, jsonText(roster));

  const record = parseJson(read, RECORD_FILE);
  const parsed = parseUpgradingNotes(record);
  if (parsed.notes === undefined) throw new PatchRefusal("record", `${RECORD_FILE} does not parse: ${parsed.problems.join("; ")}`);
  const core = manifests.find((m) => m.dir === "packages/core")!.json;
  const evePeer = isRecord(core.peerDependencies) ? core.peerDependencies.eve : undefined;
  if (typeof evePeer !== "string" || evePeer === "") throw new PatchRefusal("record", "packages/core/package.json declares no `eve` peer, so the entry has no `evePeer` to record.");
  const releases = record.releases as Json[];
  const drafts = parsed.notes.releases.filter((r) => compareVersions(r.version, from) > 0);
  let summary = PATCH_SUMMARY;
  for (const draft of drafts) {
    const lines = STEP_FIELDS.filter((f) => (f === "env" ? draft.env.added.length + draft.env.removed.length : draft[f].length) > 0);
    if (lines.length > 0) {
      throw new PatchRefusal(
        "draft-has-notes",
        `${RECORD_FILE} has a draft ${draft.version} entry with ${lines.join(", ")}. That release needs upgrade notes, so it is a manual release, not an automatic patch.`,
      );
    }
    if (draft.version !== to) {
      throw new PatchRefusal("draft-other-version", `${RECORD_FILE} has an empty draft ${draft.version} entry, and this bump makes ${to}. Delete the draft, or release ${draft.version} by hand.`);
    }
    summary = draft.summary;
  }
  if (drafts.length === 0 && noteFor(parsed.notes, from) === undefined) {
    throw new PatchRefusal("record", `${RECORD_FILE} has no entry for the current ${from}. Fix the record (\`npm run lint:upgrading-notes\`) first.`);
  }
  const entry = {
    version: to,
    date,
    summary,
    evePeer,
    breaking: [],
    configMigrations: [],
    env: { added: [], removed: [] },
    manualSteps: [],
    removedFiles: [],
    newDefaults: [],
  };
  record.releases = [entry, ...releases.slice(drafts.length)];
  writes.set(RECORD_FILE, jsonText(record));

  const sorted = new Map([...writes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { from, to, date, writes: sorted, tookOverDraft: drafts.length > 0 };
}

export interface RunOptions {
  readonly root: string;
  readonly date: string;
  readonly dryRun: boolean;
  readonly commit: boolean;
  readonly surfaceGate: (root: string) => boolean;
  readonly generate: (root: string) => void;
  readonly git: (root: string, args: readonly string[]) => string;
  readonly log: (line: string) => void;
}

function changedPaths(opts: RunOptions): string[] {
  return opts
    .git(opts.root, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.slice(3));
}

export function commitMessage(plan: PatchPlan): string {
  return `Release ${plan.to}: the patch bump from ${plan.from} (npm run release:patch)`;
}

export function runPatch(opts: RunOptions): PatchPlan {
  const plan = planPatch((path) => readFileSync(join(opts.root, path), "utf8"), opts.date);
  opts.log(`release:patch: ${plan.from} → ${plan.to}, dated ${plan.date}${plan.tookOverDraft ? " (takes over the empty draft entry)" : ""}.`);
  if (opts.dryRun) {
    for (const path of plan.writes.keys()) opts.log(`  would write ${path}`);
    for (const path of GENERATED_FILES) opts.log(`  would regenerate ${path}`);
    return plan;
  }
  if (opts.commit) {
    const dirty = changedPaths(opts);
    if (dirty.length > 0) throw new PatchRefusal("dirty-tree", `the tree has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 5).join(", ")}). The bump commit holds the bump only.`);
  }
  if (!opts.surfaceGate(opts.root)) {
    throw new PatchRefusal(
      "upgrade-surface",
      "`npm run test:upgrade-surface` is red. A name an upgrading host must act on has no step in the record, so this release is not an automatic patch.",
    );
  }
  for (const [path, text] of plan.writes) writeFileSync(join(opts.root, path), text);
  opts.generate(opts.root);
  if (!opts.commit) {
    opts.log(`✓ release:patch: wrote ${plan.to}. No commit (--no-commit).`);
    return plan;
  }
  const expected = new Set<string>([...plan.writes.keys(), ...GENERATED_FILES]);
  const stray = changedPaths(opts).filter((p) => !expected.has(p));
  if (stray.length > 0) {
    throw new PatchRefusal("stray-write", `the bump changed ${stray.join(", ")}, which a patch bump never writes. Nothing is committed. Inspect the tree, then restore it.`);
  }
  opts.git(opts.root, ["add", "--", ...[...expected].sort()]);
  opts.git(opts.root, ["commit", "--signoff", "--quiet", "-m", commitMessage(plan)]);
  opts.log(`✓ release:patch: committed ${plan.to} as ${opts.git(opts.root, ["rev-parse", "--short", "HEAD"]).trim()}.`);
  return plan;
}

export const GENERATORS = ["scripts/docs-generate.ts", "scripts/upgrading-notes-generate.ts"] as const;

export function generateWith(run: (script: string) => boolean): () => void {
  return () => {
    for (const script of GENERATORS) {
      if (!run(script)) {
        throw new PatchRefusal("generate", `${script} failed after the bump wrote its files. Nothing is committed. Inspect the tree, then restore it.`);
      }
    }
  };
}

function tsx(root: string, script: string, args: readonly string[] = []): boolean {
  const r = spawnSync(join(root, "node_modules", ".bin", "tsx"), [join(root, script), ...args], { cwd: root, stdio: "inherit" });
  return r.status === 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  let date = new Date().toISOString().slice(0, 10);
  let dryRun = false;
  let commit = true;
  const bad: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-commit") commit = false;
    else if (arg === "--date" && argv[i + 1] !== undefined) date = argv[++i]!;
    else bad.push(arg);
  }
  if (bad.length > 0) {
    console.error(`✗ release:patch: unknown or incomplete argument(s): ${bad.join(" ")}. See the header of scripts/release-patch.ts.`);
    process.exit(2);
  }
  try {
    runPatch({
      root: ROOT,
      date,
      dryRun,
      commit,
      surfaceGate: (root) => tsx(root, "scripts/upgrade-surface-test.ts"),
      generate: (root) => generateWith((script) => tsx(root, script))(),
      git: (root, args) => {
        const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git ${args.join(" ")} exited ${r.status}: ${r.stderr.trim()}`);
        return r.stdout;
      },
      log: (line) => console.log(line),
    });
  } catch (err) {
    if (err instanceof PatchRefusal) {
      console.error(`✗ release:patch refused (${err.code}): ${err.message}`);
      process.exit(err.code === "usage" ? 2 : 1);
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
