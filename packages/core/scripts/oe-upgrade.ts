import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, findRepoRoot } from "../agent/scaffold/roster-fs.js";
import { codemodById, unknownCodemods } from "./upgrade-codemods.js";
import { driftCounts, readTemplateIgnore, renderDriftReport, templateDrift } from "./template-drift.js";
import { starterRulesOffer } from "./starter-rules-offer.js";
import { NOTES_FILE, codemodIdsIn, compareVersions, notesBetween, parseUpgradingNotes, removedFilesUpTo, type ReleaseNote, type UpgradingNotes } from "./upgrade-notes.js";

export interface UpgradeRegistry {
  latestVersion(pkg: string): Promise<string | undefined>;
  evePeer(version: string): Promise<string | undefined>;
  templateDir?(version: string): Promise<string | undefined>;
  tarball?(pkg: string, version: string): string | undefined;
}

export interface UpgradeIo {
  out(line: string): void;
  err(line: string): void;
  run(command: string, args: readonly string[], cwd: string): number;
  registry: UpgradeRegistry;
}

const SCOPE = "@open-everywhere/";
const SCOPE_DIR = "@open-everywhere";
const SCAFFOLDER = `${SCOPE}create`;
const SCAFFOLDER_OLD = "create-open-everywhere";
const CORE = `${SCOPE}core`;
const EXACT = /^\d+\.\d+\.\d+$/u;

const USAGE = [
  "usage:",
  "  oe upgrade                 take the latest release of every @open-everywhere/* package",
  "  oe upgrade --to <version>  take an exact release (x.y.z)",
  "  oe upgrade --plan          print the plan; write nothing, install nothing, run nothing",
  "  oe upgrade --from <dir>    take the release packed in <dir> (npm pack output), not the registry:",
  "                             a rehearsal of an unpublished release. It pins file: tarballs.",
  "",
  "  The procedure: bump every @open-everywhere/* package together (renaming a dependency on the",
  "  retired create-open-everywhere to @open-everywhere/create), pin eve to the target core's",
  "  declared peer, npm install, run the config codemods the release notes name, then oe build",
  "  --accept, npm run typecheck, npm run build.",
  "",
  "  Both modes also list every scaffolded file that differs from the target's template (the",
  "  template drift report), and every file a crossed release removed from the template (DELETE).",
  "  oe upgrade never overwrites or deletes one: you read each diff and copy or delete the file.",
  "  A path in .oe-template-ignore (one per line, a trailing / for a directory) is the app's own:",
  "  the report asks nothing for it.",
].join("\n");

interface AppManifest {
  readonly path: string;
  readonly json: Record<string, unknown>;
  readonly pinned: readonly { readonly name: string; readonly section: string; readonly range: string }[];
}

function dependencySections(json: Record<string, unknown>): readonly [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [];
  for (const section of ["dependencies", "devDependencies"]) {
    const value = json[section];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) out.push([section, value as Record<string, unknown>]);
  }
  return out;
}

function readManifest(appRoot: string): AppManifest | string {
  const path = join(appRoot, "package.json");
  if (!existsSync(path)) return `${path} does not exist — \`oe upgrade\` runs from an Open Everywhere app root.`;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`;
  }
  const pinned: { name: string; section: string; range: string }[] = [];
  for (const [section, deps] of dependencySections(json)) {
    for (const [name, range] of Object.entries(deps)) {
      if ((name.startsWith(SCOPE) || name === SCAFFOLDER_OLD) && typeof range === "string") pinned.push({ name, section, range });
    }
  }
  return { path, json, pinned };
}

type NotesRead = { readonly kind: "absent" } | { readonly kind: "broken"; readonly problems: readonly string[] } | { readonly kind: "ok"; readonly notes: UpgradingNotes };

function readInstalledNotes(appRoot: string): NotesRead {
  const path = join(appRoot, "node_modules", SCOPE_DIR, "core", NOTES_FILE);
  if (!existsSync(path)) return { kind: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { kind: "broken", problems: [`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`] };
  }
  const parsed = parseUpgradingNotes(raw);
  return parsed.notes === undefined ? { kind: "broken", problems: parsed.problems } : { kind: "ok", notes: parsed.notes };
}

const RESUME_MARKER = join(".open-everywhere", "upgrade-resume.json");

type ResumeRead =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "resume"; readonly from: string; readonly target: string };

function readResumeMarker(appRoot: string): ResumeRead {
  const path = join(appRoot, RESUME_MARKER);
  if (!existsSync(path)) return { kind: "none" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { from?: unknown; target?: unknown };
    if (typeof raw.from !== "string" || !EXACT.test(raw.from)) return { kind: "unreadable" };
    if (typeof raw.target !== "string" || !EXACT.test(raw.target)) return { kind: "unreadable" };
    return { kind: "resume", from: raw.from, target: raw.target };
  } catch {
    return { kind: "unreadable" };
  }
}

function installedCoreVersion(appRoot: string): string | undefined {
  const manifest = join(appRoot, "node_modules", SCOPE_DIR, "core", "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" && EXACT.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function installedOeBin(appRoot: string): readonly [string, readonly string[]] | undefined {
  const manifest = join(appRoot, "node_modules", SCOPE_DIR, "core", "package.json");
  if (!existsSync(manifest)) return undefined;
  let rel: unknown;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
    rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.oe;
  } catch {
    return undefined;
  }
  if (typeof rel !== "string") return undefined;
  const script = join(dirname(manifest), rel);
  return existsSync(script) ? [process.execPath, [script]] : undefined;
}

export const LOCKFILE = "package-lock.json";

function inUpgradeSet(name: string): boolean {
  return name === "eve" || name.startsWith(SCOPE) || name === SCAFFOLDER_OLD;
}

export function lockfileEntriesToDrop(lock: unknown): readonly string[] {
  if (typeof lock !== "object" || lock === null) return [];
  const packages = (lock as { packages?: unknown }).packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) return [];
  const out: string[] = [];
  for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
    const at = key.lastIndexOf("node_modules/");
    if (at < 0 || typeof entry !== "object" || entry === null) continue;
    const e = entry as { link?: unknown; peerDependencies?: unknown };
    if (e.link === true) continue;
    const name = key.slice(at + "node_modules/".length);
    const peers = typeof e.peerDependencies === "object" && e.peerDependencies !== null ? Object.keys(e.peerDependencies) : [];
    if (inUpgradeSet(name) || peers.some(inUpgradeSet)) out.push(key);
  }
  const nested = Object.keys(packages as Record<string, unknown>).filter((key) => !out.includes(key) && out.some((d) => key.startsWith(`${d}/node_modules/`)));
  return [...out, ...nested];
}

function dropLegacyDependencies(tree: unknown): number {
  if (typeof tree !== "object" || tree === null) return 0;
  let dropped = 0;
  for (const [name, entry] of Object.entries(tree as Record<string, unknown>)) {
    if (inUpgradeSet(name)) {
      delete (tree as Record<string, unknown>)[name];
      dropped++;
      continue;
    }
    if (typeof entry === "object" && entry !== null) dropped += dropLegacyDependencies((entry as { dependencies?: unknown }).dependencies);
  }
  return dropped;
}

function planLockfilePrune(appRoot: string): { readonly lock: Record<string, unknown>; readonly keys: readonly string[] } | undefined {
  const path = join(appRoot, LOCKFILE);
  if (!existsSync(path)) return undefined;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof lock !== "object" || lock === null || Array.isArray(lock)) return undefined;
    return { lock: lock as Record<string, unknown>, keys: lockfileEntriesToDrop(lock) };
  } catch {
    return undefined;
  }
}

function pruneLockfile(appRoot: string, planned: { readonly lock: Record<string, unknown>; readonly keys: readonly string[] }): number {
  const packages = planned.lock.packages as Record<string, unknown>;
  for (const key of planned.keys) delete packages[key];
  const legacy = dropLegacyDependencies(planned.lock.dependencies);
  const dropped = planned.keys.length + legacy;
  if (dropped > 0) writeFileSync(join(appRoot, LOCKFILE), `${JSON.stringify(planned.lock, null, 2)}\n`);
  return dropped;
}

function installedTemplateDir(appRoot: string, version: string): string | undefined {
  const root = join(appRoot, "node_modules", SCOPE_DIR, "create");
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (pkg.version !== version) return undefined;
  } catch {
    return undefined;
  }
  const template = join(root, "template");
  return existsSync(join(template, "package.json")) ? template : undefined;
}

function ownNotes(): UpgradingNotes | undefined {
  for (const rel of ["../upgrading.json", "../../upgrading.json"]) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (!existsSync(path)) continue;
    try {
      return parseUpgradingNotes(JSON.parse(readFileSync(path, "utf8"))).notes;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function reportTemplateDrift(
  io: UpgradeIo,
  appRoot: string,
  target: string,
  manifest: AppManifest,
  notes: UpgradingNotes | undefined,
  registry: UpgradeRegistry,
): Promise<{ readonly sync: number; readonly delete: number } | undefined> {
  let templateDir: string | undefined;
  try {
    templateDir = installedTemplateDir(appRoot, target) ?? (await registry.templateDir?.(target));
  } catch (err) {
    io.out(`! the template drift check did not run: ${err instanceof Error ? err.message : String(err)}`);
    for (const line of starterRulesOffer(appRoot, target, undefined)) io.out(line);
    return undefined;
  }
  for (const line of starterRulesOffer(appRoot, target, templateDir)) io.out(line);
  if (templateDir === undefined) {
    io.out(`! cannot read ${target}'s @open-everywhere/create template, so the template drift check did not run.`);
    io.out(`  Compare agent/lib/register-adapters.ts and the other scaffolded files with that template by hand.`);
    return undefined;
  }
  const appName = typeof manifest.json.name === "string" && manifest.json.name !== "" ? manifest.json.name : "open-everywhere-app";
  let lines: readonly string[];
  let counts: { readonly sync: number; readonly delete: number };
  try {
    const removedFiles = [...new Set([notes, ownNotes()].flatMap((n) => (n === undefined ? [] : removedFilesUpTo(n, target))))];
    const report = templateDrift({ appRoot, templateDir, version: target, appName, removedFiles, ignore: readTemplateIgnore(appRoot) });
    lines = renderDriftReport(report, target, templateDir);
    counts = driftCounts(report);
  } catch (err) {
    io.out(`! the template drift check did not run: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  for (const line of lines) io.out(line);
  return counts;
}

function npmCommand(args: readonly string[]): readonly [string, readonly string[]] {
  if (process.platform !== "win32") return ["npm", [...args]];
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")].find(
    (p): p is string => typeof p === "string" && p.endsWith(".js") && existsSync(p),
  );
  if (cli === undefined) throw new Error("oe upgrade: cannot find npm-cli.js beside this Node — run `npm install` yourself, then run the same command again.");
  return [process.execPath, [cli, ...args]];
}

function printNote(io: UpgradeIo, note: ReleaseNote): void {
  io.out(`  ── ${note.version} (${note.date}) — ${note.summary}`);
  for (const b of note.breaking) io.out(`     BREAKING  ${b}`);
  for (const m of note.configMigrations) io.out(`     CONFIG    ${m.description}${m.codemod === undefined ? " (apply by hand)" : ` (codemod ${m.codemod})`}`);
  for (const n of note.env.added) io.out(`     ENV +     ${n}`);
  for (const n of note.env.removed) io.out(`     ENV -     ${n}`);
  for (const s of note.manualSteps) io.out(`     MANUAL    ${s}`);
}

function printWindow(io: UpgradeIo, window: readonly ReleaseNote[], installed: string, target: string): void {
  if (window.length === 0) {
    io.out(`  (the installed release notes hold no entry between ${installed} and ${target} — the target's own copy is read after the install)`);
    return;
  }
  for (const note of window) printNote(io, note);
  if (window[window.length - 1]!.version !== target) {
    io.out(`  (no entry for ${target} yet in the installed copy — the target's own copy is read after the install)`);
  }
}

function applyPins(manifest: AppManifest, target: string, evePeer: string, spec: (name: string) => string = () => target): readonly string[] {
  const changes: string[] = [];
  for (const [section, deps] of dependencySections(manifest.json)) {
    for (const [name, range] of Object.entries(deps)) {
      if (!(name.startsWith(SCOPE) || name === SCAFFOLDER_OLD)) continue;
      if (name === SCAFFOLDER_OLD) {
        delete deps[name];
        deps[SCAFFOLDER] = spec(SCAFFOLDER);
        changes.push(`${section}.${name} → ${section}.${SCAFFOLDER}: ${String(range)} → ${spec(SCAFFOLDER)} (the scaffolder moved into the scope)`);
        continue;
      }
      if (range === spec(name)) continue;
      deps[name] = spec(name);
      changes.push(`${section}.${name}: ${String(range)} → ${spec(name)}`);
    }
    if (typeof deps.eve === "string" && deps.eve !== evePeer) {
      changes.push(`${section}.eve: ${deps.eve} → ${evePeer} (core's declared peer at ${target})`);
      deps.eve = evePeer;
    }
  }
  return changes;
}

function step(io: UpgradeIo, appRoot: string, label: string, command: readonly [string, readonly string[]], recovery: readonly string[] = []): boolean {
  io.out(`→ ${label}`);
  const code = io.run(command[0], command[1], appRoot);
  if (code === 0) return true;
  io.err(`✗ oe upgrade: ${label} exited ${code}. Nothing after this step ran.`);
  for (const line of recovery) io.err(`  ${line}`);
  io.err(`  Fix the cause, then run the same command again: it resumes from here rather than reporting there is nothing to do.`);
  return false;
}

const INSTALL_RECOVERY: readonly string[] = [
  `If npm reported ERESOLVE, ${LOCKFILE} still locks a package against the old eve or the old @open-everywhere/* set.`,
  `Run \`rm ${LOCKFILE} && npm install\`, then read the lockfile diff before you commit it.`,
];

export async function runUpgradeCommand(args: readonly string[], io: UpgradeIo, cwd: string): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  const plan = args.includes("--plan");
  const toIndex = args.indexOf("--to");
  const inline = args.find((a) => a.startsWith("--to="));
  const requested = toIndex >= 0 ? args[toIndex + 1] : inline?.slice("--to=".length);
  if ((toIndex >= 0 || inline !== undefined) && (requested === undefined || !EXACT.test(requested))) {
    io.err(`✗ oe upgrade: --to takes an exact version like 0.1.4.`);
    io.err(USAGE);
    return 2;
  }
  const fromIndex = args.indexOf("--from");
  const fromInline = args.find((a) => a.startsWith("--from="));
  const fromArg = fromIndex >= 0 ? args[fromIndex + 1] : fromInline?.slice("--from=".length);
  if ((fromIndex >= 0 || fromInline !== undefined) && (fromArg === undefined || fromArg === "" || fromArg.startsWith("--"))) {
    io.err(`✗ oe upgrade: --from takes a directory of packed tarballs.`);
    io.err(USAGE);
    return 2;
  }
  const unknownFlag = args.find((a) => a.startsWith("--") && !["--plan", "--to", "--from", "--help"].includes(a) && !a.startsWith("--to=") && !a.startsWith("--from="));
  if (unknownFlag !== undefined) {
    io.err(`✗ oe upgrade: unknown flag "${unknownFlag}".`);
    io.err(USAGE);
    return 2;
  }
  const stray = args.find((a, i) => !a.startsWith("--") && !(toIndex >= 0 && i === toIndex + 1) && !(fromIndex >= 0 && i === fromIndex + 1));
  if (stray !== undefined) {
    io.err(`✗ oe upgrade: unexpected argument "${stray}" — the version goes after --to.`);
    io.err(USAGE);
    return 2;
  }

  const appRoot = findRepoRoot(cwd);
  if (appRoot === undefined) {
    io.err(`✗ oe upgrade: no ${CONFIG_FILE} found in ${cwd} or any parent directory — run this from an Open Everywhere app root.`);
    return 1;
  }

  const manifest = readManifest(appRoot);
  if (typeof manifest === "string") {
    io.err(`✗ oe upgrade: ${manifest}`);
    return 1;
  }
  const core = manifest.pinned.find((p) => p.name === CORE);
  if (core === undefined) {
    io.err(`✗ oe upgrade: ${manifest.path} declares no ${CORE} dependency — this is not an Open Everywhere app.`);
    return 1;
  }
  let registry = io.registry;
  if (fromArg !== undefined) {
    const local = localReleaseRegistry(resolve(cwd, fromArg));
    if (typeof local === "string") {
      io.err(`✗ oe upgrade: ${local}`);
      return 1;
    }
    registry = local;
  }
  const coreRange = core.range.startsWith("file:") ? installedCoreVersion(appRoot) : core.range;
  if (coreRange === undefined) {
    io.err(`✗ oe upgrade: ${CORE} is pinned to "${core.range}", and no ${CORE} is installed, so the version it names cannot be read.`);
    io.err(`  Set the pin to the exact version you are on, then run the same command again.`);
    return 1;
  }
  if (!EXACT.test(coreRange)) {
    io.err(`✗ oe upgrade: ${CORE} is pinned to "${core.range}", not an exact version.`);
    io.err(`  The eleven packages publish in lockstep, so an app pins each one exactly. Set it to the version you are on, then run the same command again.`);
    return 1;
  }
  const pinned = coreRange;
  const retiredScaffolder = manifest.pinned.some((p) => p.name === SCAFFOLDER_OLD);
  const onDisk = installedCoreVersion(appRoot);
  const marker = readResumeMarker(appRoot);

  const target = requested ?? (await registry.latestVersion(CORE));
  if (target === undefined) {
    io.err(
      fromArg === undefined
        ? `✗ oe upgrade: the registry did not answer with a latest version for ${CORE}. Pass \`--to <version>\`.`
        : `✗ oe upgrade: ${fromArg} holds no ${CORE} tarball. Pack the release into it first.`,
    );
    return 1;
  }
  const tarballOf = registry.tarball?.bind(registry);
  if (tarballOf !== undefined) {
    const names = [...new Set([CORE, ...manifest.pinned.map((p) => (p.name === SCAFFOLDER_OLD ? SCAFFOLDER : p.name))])];
    const missing = names.filter((name) => tarballOf(name, target) === undefined);
    if (missing.length > 0) {
      io.err(`✗ oe upgrade: ${fromArg} holds no ${target} tarball for ${missing.join(", ")}. The app pins it, and the set moves together.`);
      return 1;
    }
  }
  const spec = (name: string): string => {
    const file = tarballOf?.(name, target);
    return file === undefined ? target : `file:${file}`;
  };

  const current = onDisk ?? pinned;
  if (compareVersions(target, current) < 0) {
    io.err(`✗ oe upgrade: ${target} is older than the installed ${current}. This command does not downgrade.`);
    return 1;
  }

  const resumeBaseline = marker.kind === "resume" && compareVersions(marker.from, target) < 0 ? marker.from : undefined;
  const installed = resumeBaseline ?? current;
  const pinsMatch = manifest.pinned.every((p) => p.range === spec(p.name));
  if (pinned === target && pinsMatch && onDisk === target && marker.kind === "none" && !retiredScaffolder) {
    io.out(`✓ oe upgrade: already on ${installed}. Nothing to do.`);
    const here = readInstalledNotes(appRoot);
    await reportTemplateDrift(io, appRoot, target, manifest, here.kind === "ok" ? here.notes : undefined, registry);
    return 0;
  }
  if (retiredScaffolder && pinned === target && onDisk === target && marker.kind === "none") {
    io.out(`· already on ${installed}, but the manifest still names ${SCAFFOLDER_OLD}. Renaming it to ${SCAFFOLDER} and re-installing.`);
  }
  if (marker.kind === "unreadable") {
    io.out(`! an upgrade marker is present but unreadable, so the version the earlier run started from is lost.`);
    io.out(`  Resuming. The release-note window below may be short — read UPGRADING.md for the entries you crossed.`);
  } else if (marker.kind === "resume") {
    io.out(`· an earlier run began taking ${marker.target} and stopped before the tree was proven. Resuming from ${installed}.`);
  } else if (pinned === target && onDisk === target && !pinsMatch && !retiredScaffolder) {
    io.out(`· ${target} is installed, but the pins do not name this run's ${target} source. Re-pinning and re-installing.`);
  } else if (pinned === target) {
    io.out(`· the manifest already pins ${target} but ${onDisk ?? "nothing"} is installed — an earlier run stopped part way. Resuming.`);
  }

  const evePeer = await registry.evePeer(target);
  if (evePeer === undefined) {
    io.err(`✗ oe upgrade: cannot read the \`eve\` peer ${CORE}@${target} declares. Without it the install would leave eve on a version core does not support.`);
    return 1;
  }

  io.out(`oe upgrade: ${installed} → ${target} (eve ${evePeer})`);
  io.out(`Release notes:`);
  const before = readInstalledNotes(appRoot);
  if (before.kind === "broken") for (const p of before.problems) io.err(`! the installed ${NOTES_FILE} does not parse: ${p}`);
  const own = ownNotes();
  const covers = (notes: UpgradingNotes | undefined): boolean => notes?.releases.some((r) => r.version === target) ?? false;
  const fromOwn = !covers(before.kind === "ok" ? before.notes : undefined) && covers(own);
  const adviseFrom = fromOwn ? own : before.kind === "ok" ? before.notes : undefined;
  const windowBefore = adviseFrom === undefined ? [] : notesBetween(adviseFrom, installed, target);
  if (before.kind !== "ok") io.out(`  (the installed ${CORE} ships no readable ${NOTES_FILE} — the target's own copy is read after the install)`);
  if (fromOwn) io.out(`  (read from this oe's own ${NOTES_FILE}, because the installed copy has no entry for ${target})`);
  if (adviseFrom !== undefined) printWindow(io, windowBefore, installed, target);

  const unknownBefore = unknownCodemods(windowBefore);
  if (unknownBefore.length > 0) {
    io.err(`! the release notes name ${unknownBefore.length} codemod(s) this CLI does not hold: ${unknownBefore.join(", ")}.`);
    io.err(`  ${target}'s own registry decides after the install, and it refuses an id it does not hold before any codemod runs.`);
  }

  const pinChanges = applyPins({ ...manifest, json: structuredClone(manifest.json) }, target, evePeer, spec);
  io.out(`Plan:`);
  for (const line of pinChanges) io.out(`  pin  ${line}`);
  const lockPlan = planLockfilePrune(appRoot);
  if (lockPlan !== undefined && lockPlan.keys.length > 0) {
    io.out(`  edit ${LOCKFILE}: drop the ${lockPlan.keys.length} locked entries of eve, @open-everywhere/* and their peer dependents, so npm resolves them together`);
  }
  io.out(`  run  npm install`);
  const planned = codemodIdsIn(windowBefore);
  if (planned.length === 0) io.out(`  run  the config codemods the target's notes name (the notes read so far name none)`);
  for (const id of planned) io.out(`  run  codemod ${id} — ${codemodById(id)?.describe ?? `(not in this CLI's registry — ${target}'s registry resolves it)`}`);
  io.out(`  run  oe build --accept   (then READ the roster.lock.json diff — every line is a capability decision)`);
  io.out(`  run  npm run typecheck`);
  io.out(`  run  npm run build`);

  if (plan) {
    await reportTemplateDrift(io, appRoot, target, manifest, before.kind === "ok" ? before.notes : undefined, registry);
    io.out(`✓ oe upgrade --plan: nothing was written.`);
    return 0;
  }

  if (pinChanges.length === 0) {
    io.out(`· ${manifest.path} already names ${target} — left untouched.`);
  } else {
    applyPins(manifest, target, evePeer, spec);
    writeFileSync(manifest.path, `${JSON.stringify(manifest.json, null, 2)}\n`);
    io.out(`✓ wrote ${manifest.path}`);
  }

  mkdirSync(dirname(join(appRoot, RESUME_MARKER)), { recursive: true });
  writeFileSync(join(appRoot, RESUME_MARKER), `${JSON.stringify({ from: installed, target })}\n`);
  if (lockPlan !== undefined) {
    const dropped = pruneLockfile(appRoot, lockPlan);
    if (dropped > 0) io.out(`✓ dropped ${dropped} locked entries from ${LOCKFILE} (eve, @open-everywhere/* and their peer dependents)`);
  }
  if (!step(io, appRoot, "npm install", npmCommand(["install"]), INSTALL_RECOVERY)) return 1;

  const after = readInstalledNotes(appRoot);
  if (after.kind === "broken") {
    io.err(`✗ oe upgrade: ${target} ships a ${NOTES_FILE} that does not parse, so its codemods, env names and manual steps cannot be read:`);
    for (const p of after.problems) io.err(`  - ${p}`);
    io.err(`  The packages are bumped and installed. Read ${target}'s UPGRADING.md by hand, then run \`oe build --accept\`, \`npm run typecheck\` and \`npm run build\`.`);
    return 1;
  }
  if (after.kind === "absent" && (before.kind !== "absent" || marker.kind !== "none")) {
    const why = before.kind !== "absent" ? "the installed core did" : "an earlier `oe upgrade` left a resume marker, and every core that writes one ships the record";
    io.err(`✗ oe upgrade: ${target} ships no ${NOTES_FILE}, but ${why}, so ${target}'s codemods, env names and manual steps cannot be read.`);
    io.err(`  The packages are bumped and installed. Reinstall (\`rm -rf node_modules && npm ci\`), then run \`oe upgrade\` again: it resumes.`);
    io.err(`  If ${target} still ships none, its package is broken: run \`oe upgrade --to <a release that ships one>\`.`);
    return 1;
  }
  const windowAfter = after.kind === "ok" ? notesBetween(after.notes, installed, target) : [];
  if (after.kind === "absent") io.out(`· ${target} ships no ${NOTES_FILE} — it predates the release record. There are no codemods to run.`);
  else if (windowAfter.length === 0) io.out(`· ${target}'s ${NOTES_FILE} holds no entry above ${installed}. There are no codemods to run.`);
  else {
    io.out(`Release notes (${target}'s own copy):`);
    printWindow(io, windowAfter, installed, target);
  }
  const drift = await reportTemplateDrift(io, appRoot, target, manifest, after.kind === "ok" ? after.notes : undefined, registry);
  const oe = installedOeBin(appRoot);
  if (oe === undefined) {
    io.err(`✗ oe upgrade: the install left no \`oe\` bin under node_modules/${CORE}. The install did not complete.`);
    return 1;
  }
  for (const release of windowAfter) {
    for (const migration of release.configMigrations) {
      if (migration.codemod === undefined) io.out(`! ${release.version} CONFIG (apply by hand): ${migration.description}`);
    }
  }
  const codemods = codemodIdsIn(windowAfter);
  if (codemods.length > 0 && !step(io, appRoot, `codemods ${codemods.join(", ")} (${target}'s own registry)`, [oe[0], [...oe[1], "upgrade-codemods", ...codemods]])) {
    return 1;
  }
  if (!step(io, appRoot, "oe build --accept", [oe[0], [...oe[1], "build", "--accept"]])) return 1;
  if (!step(io, appRoot, "npm run typecheck", npmCommand(["run", "typecheck"]))) return 1;
  if (!step(io, appRoot, "npm run build", npmCommand(["run", "build"]))) return 1;

  rmSync(join(appRoot, RESUME_MARKER), { force: true });
  io.out(`✓ oe upgrade: ${installed} → ${target}.`);
  io.out(`  READ the roster.lock.json diff before you commit — every line is a capability decision.`);
  for (const release of windowAfter) {
    for (const name of release.env.added) io.out(`  ENV: add ${name} to the deployment's environment before the next deploy (${release.version}).`);
    for (const name of release.env.removed) io.out(`  ENV: ${name} is no longer read; remove it after the next deploy (${release.version}).`);
    for (const manual of release.manualSteps) io.out(`  MANUAL (${release.version}): ${manual}`);
  }
  if (drift !== undefined && drift.delete > 0) {
    io.out(`  DELETE: ${drift.delete} file(s) that a release removed from the template are still in the app — see the drift report above. oe upgrade deleted none of them.`);
  }
  if (drift !== undefined && drift.sync > 0) {
    io.out(`  SYNC: ${drift.sync} template-owned file(s) differ from ${target}'s template — see the drift report above. oe upgrade changed none of them.`);
  }
  if (tarballOf !== undefined) {
    io.out(`  REHEARSAL: package.json pins the @open-everywhere/* set to file: tarballs in ${fromArg}. Do not commit it or the lockfile.`);
  }
  return 0;
}

export function runUpgradeCodemodsCommand(ids: readonly string[], io: Pick<UpgradeIo, "out" | "err">, cwd: string): number {
  if (ids.length === 0 || ids.some((id) => id.startsWith("-"))) {
    io.err("✗ oe upgrade-codemods: usage: oe upgrade-codemods <codemod id>… — `oe upgrade` runs this; an operator does not.");
    return 2;
  }
  const appRoot = findRepoRoot(cwd);
  if (appRoot === undefined) {
    io.err(`✗ oe upgrade-codemods: no ${CONFIG_FILE} found in ${cwd} or any parent directory.`);
    return 1;
  }
  const unknown = ids.filter((id) => codemodById(id) === undefined);
  if (unknown.length > 0) {
    io.err(`✗ oe upgrade: the release notes name ${unknown.length} codemod(s) the installed core's registry does not hold: ${unknown.join(", ")}.`);
    io.err("  The packages are bumped and installed, and no codemod ran. The release that names them does not ship them.");
    io.err("  Run `oe upgrade --to <a later release that holds them>`. The resume marker keeps this release in that run's window, so it applies them.");
    return 1;
  }
  for (const id of ids) {
    const codemod = codemodById(id)!;
    io.out(`→ codemod ${codemod.id} — ${codemod.describe}`);
    let changed: readonly string[];
    try {
      changed = codemod.run(appRoot);
    } catch (err) {
      io.err(`✗ oe upgrade: codemod ${codemod.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (changed.length === 0) io.out("  · nothing to change — the tree already satisfies it");
    for (const line of changed) io.out(`  · ${line}`);
  }
  return 0;
}

function npmViewRegistry(): UpgradeRegistry {
  const view = (args: readonly string[]): unknown => {
    const [command, argv] = npmCommand(["view", ...args, "--json"]);
    const r = spawnSync(command, [...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0 || typeof r.stdout !== "string" || r.stdout.trim() === "") return undefined;
    try {
      return JSON.parse(r.stdout) as unknown;
    } catch {
      return undefined;
    }
  };
  return {
    latestVersion: async (pkg) => {
      const v = view([`${pkg}@latest`, "version"]);
      return typeof v === "string" && EXACT.test(v) ? v : undefined;
    },
    evePeer: async (version) => {
      const v = view([`${CORE}@${version}`, "peerDependencies.eve"]);
      return typeof v === "string" && v.trim() !== "" ? v : undefined;
    },
    templateDir: async (version) => {
      const dir = mkdtempSync(join(tmpdir(), "oe-upgrade-template-"));
      const [command, argv] = npmCommand(["pack", `${SCAFFOLDER}@${version}`, "--pack-destination", dir, "--json"]);
      const packed = spawnSync(command, [...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (packed.status !== 0 || typeof packed.stdout !== "string") return undefined;
      let file: unknown;
      try {
        file = (JSON.parse(packed.stdout) as { filename?: unknown }[])[0]?.filename;
      } catch {
        return undefined;
      }
      if (typeof file !== "string") return undefined;
      const untar = spawnSync("tar", ["-xzf", file, "-C", dir], { cwd: dir, stdio: "ignore" });
      const template = join(dir, "package", "template");
      return untar.status === 0 && existsSync(join(template, "package.json")) ? template : undefined;
    },
  };
}

function localReleaseRegistry(dir: string): (UpgradeRegistry & { tarball(pkg: string, version: string): string | undefined }) | string {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return `--from ${dir} is not a directory.`;
  const index = new Map<string, { readonly file: string; readonly manifest: Record<string, unknown> }>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".tgz")).sort()) {
    const r = spawnSync("tar", ["-xzOf", name, "package/package.json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return `cannot read package/package.json from ${join(dir, name)} — is it an npm pack tarball?`;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      return `${join(dir, name)} carries a package.json that is not valid JSON.`;
    }
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return `${join(dir, name)} carries no package name and version.`;
    index.set(`${manifest.name}@${manifest.version}`, { file: join(dir, name), manifest });
  }
  if (index.size === 0) {
    const checkout = existsSync(join(dir, "packages", "core", "package.json"));
    return checkout
      ? `${dir} is a checkout, not a directory of tarballs. In it run \`npm run build:packages && npm pack --workspaces --pack-destination <dir>\`, then pass that <dir>.`
      : `${dir} holds no .tgz file. Pack the release into it with \`npm pack --workspaces --pack-destination ${dir}\`.`;
  }
  const cores = [...index.values()].filter((e) => e.manifest.name === CORE).map((e) => e.manifest.version as string).filter((v) => EXACT.test(v));
  const highest = cores.sort(compareVersions).at(-1);
  const extracted = new Map<string, string | undefined>();
  return {
    latestVersion: async (pkg) => (pkg === CORE ? highest : undefined),
    evePeer: async (version) => {
      const peers = index.get(`${CORE}@${version}`)?.manifest.peerDependencies as Record<string, unknown> | undefined;
      const eve = peers?.eve;
      return typeof eve === "string" && eve.trim() !== "" ? eve : undefined;
    },
    templateDir: async (version) => {
      const entry = index.get(`${SCAFFOLDER}@${version}`);
      if (entry === undefined) return undefined;
      if (!extracted.has(version)) {
        const into = mkdtempSync(join(tmpdir(), "oe-upgrade-template-"));
        const untar = spawnSync("tar", ["-xzf", basename(entry.file), "-C", into], { cwd: dir, stdio: "ignore" });
        const template = join(into, "package", "template");
        extracted.set(version, untar.status === 0 && existsSync(join(template, "package.json")) ? template : undefined);
      }
      return extracted.get(version);
    },
    tarball: (pkg, version) => index.get(`${pkg}@${version}`)?.file,
  };
}

export function realUpgradeIo(): UpgradeIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    run: (command, args, cwd) => spawnSync(command, [...args], { cwd, stdio: "inherit" }).status ?? 1,
    registry: npmViewRegistry(),
  };
}
