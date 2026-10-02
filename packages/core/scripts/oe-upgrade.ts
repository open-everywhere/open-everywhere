import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_FILE, findRepoRoot } from "../agent/scaffold/roster-fs.js";
import { codemodById, unknownCodemods } from "./upgrade-codemods.js";
import { NOTES_FILE, codemodIdsIn, compareVersions, notesBetween, parseUpgradingNotes, type ReleaseNote, type UpgradingNotes } from "./upgrade-notes.js";

export interface UpgradeRegistry {
  latestVersion(pkg: string): Promise<string | undefined>;
  evePeer(version: string): Promise<string | undefined>;
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
  "",
  "  The procedure: bump every @open-everywhere/* package together (renaming a dependency on the",
  "  retired create-open-everywhere to @open-everywhere/create), pin eve to the target core's",
  "  declared peer, npm install, run the config codemods the release notes name, then oe build",
  "  --accept, npm run typecheck, npm run build.",
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

function npmCommand(args: readonly string[]): readonly [string, readonly string[]] {
  if (process.platform !== "win32") return ["npm", [...args]];
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")].find(
    (p): p is string => typeof p === "string" && p.endsWith(".js") && existsSync(p),
  );
  if (cli === undefined) throw new Error("oe upgrade: cannot find npm-cli.js beside this Node — run `npm install` yourself, then `oe upgrade` again.");
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

function applyPins(manifest: AppManifest, target: string, evePeer: string): readonly string[] {
  const changes: string[] = [];
  for (const [section, deps] of dependencySections(manifest.json)) {
    for (const [name, range] of Object.entries(deps)) {
      if (!(name.startsWith(SCOPE) || name === SCAFFOLDER_OLD)) continue;
      if (name === SCAFFOLDER_OLD) {
        delete deps[name];
        deps[SCAFFOLDER] = target;
        changes.push(`${section}.${name} → ${section}.${SCAFFOLDER}: ${String(range)} → ${target} (the scaffolder moved into the scope)`);
        continue;
      }
      if (range === target) continue;
      deps[name] = target;
      changes.push(`${section}.${name}: ${String(range)} → ${target}`);
    }
    if (typeof deps.eve === "string" && deps.eve !== evePeer) {
      changes.push(`${section}.eve: ${deps.eve} → ${evePeer} (core's declared peer at ${target})`);
      deps.eve = evePeer;
    }
  }
  return changes;
}

function step(io: UpgradeIo, appRoot: string, label: string, command: readonly [string, readonly string[]]): boolean {
  io.out(`→ ${label}`);
  const code = io.run(command[0], command[1], appRoot);
  if (code === 0) return true;
  io.err(`✗ oe upgrade: ${label} exited ${code}. Nothing after this step ran.`);
  io.err(`  Fix the cause, then run \`oe upgrade\` again: it resumes from here rather than reporting there is nothing to do.`);
  return false;
}

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
  const unknownFlag = args.find((a) => a.startsWith("--") && !["--plan", "--to", "--help"].includes(a) && !a.startsWith("--to="));
  if (unknownFlag !== undefined) {
    io.err(`✗ oe upgrade: unknown flag "${unknownFlag}".`);
    io.err(USAGE);
    return 2;
  }
  const stray = args.find((a, i) => !a.startsWith("--") && !(toIndex >= 0 && i === toIndex + 1));
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
  if (!EXACT.test(core.range)) {
    io.err(`✗ oe upgrade: ${CORE} is pinned to "${core.range}", not an exact version.`);
    io.err(`  The nine packages publish in lockstep, so an app pins each one exactly. Set it to the version you are on, then run \`oe upgrade\` again.`);
    return 1;
  }
  const pinned = core.range;
  const retiredScaffolder = manifest.pinned.some((p) => p.name === SCAFFOLDER_OLD);
  const onDisk = installedCoreVersion(appRoot);
  const marker = readResumeMarker(appRoot);

  const target = requested ?? (await io.registry.latestVersion(CORE));
  if (target === undefined) {
    io.err(`✗ oe upgrade: the registry did not answer with a latest version for ${CORE}. Pass \`--to <version>\`.`);
    return 1;
  }

  const current = onDisk ?? pinned;
  if (compareVersions(target, current) < 0) {
    io.err(`✗ oe upgrade: ${target} is older than the installed ${current}. This command does not downgrade.`);
    return 1;
  }

  const resumeBaseline = marker.kind === "resume" && compareVersions(marker.from, target) < 0 ? marker.from : undefined;
  const installed = resumeBaseline ?? current;
  if (pinned === target && onDisk === target && marker.kind === "none" && !retiredScaffolder) {
    io.out(`✓ oe upgrade: already on ${installed}. Nothing to do.`);
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
  } else if (pinned === target) {
    io.out(`· the manifest already pins ${target} but ${onDisk ?? "nothing"} is installed — an earlier run stopped part way. Resuming.`);
  }

  const evePeer = await io.registry.evePeer(target);
  if (evePeer === undefined) {
    io.err(`✗ oe upgrade: cannot read the \`eve\` peer ${CORE}@${target} declares. Without it the install would leave eve on a version core does not support.`);
    return 1;
  }

  io.out(`oe upgrade: ${installed} → ${target} (eve ${evePeer})`);
  io.out(`Release notes:`);
  const before = readInstalledNotes(appRoot);
  if (before.kind === "broken") for (const p of before.problems) io.err(`! the installed ${NOTES_FILE} does not parse: ${p}`);
  const windowBefore = before.kind === "ok" ? notesBetween(before.notes, installed, target) : [];
  if (before.kind === "ok") printWindow(io, windowBefore, installed, target);
  else io.out(`  (the installed ${CORE} ships no readable ${NOTES_FILE} — the target's own copy is read after the install)`);

  const unknownBefore = unknownCodemods(windowBefore);
  if (unknownBefore.length > 0) {
    io.err(`✗ oe upgrade: the release notes name ${unknownBefore.length} codemod(s) this CLI does not hold: ${unknownBefore.join(", ")}.`);
    io.err(`  A newer ${CORE} ships them. Upgrade in one step to a version that does, or apply those migrations by hand.`);
    return 1;
  }

  const pinChanges = applyPins({ ...manifest, json: structuredClone(manifest.json) }, target, evePeer);
  io.out(`Plan:`);
  for (const line of pinChanges) io.out(`  pin  ${line}`);
  io.out(`  run  npm install`);
  const planned = codemodIdsIn(windowBefore);
  if (planned.length === 0) io.out(`  run  the config codemods the target's notes name (the notes read so far name none)`);
  for (const id of planned) io.out(`  run  codemod ${id} — ${codemodById(id)?.describe ?? "(no description)"}`);
  io.out(`  run  oe build --accept   (then READ the roster.lock.json diff — every line is a capability decision)`);
  io.out(`  run  npm run typecheck`);
  io.out(`  run  npm run build`);

  if (plan) {
    io.out(`✓ oe upgrade --plan: nothing was written.`);
    return 0;
  }

  if (pinChanges.length === 0) {
    io.out(`· ${manifest.path} already names ${target} — left untouched.`);
  } else {
    applyPins(manifest, target, evePeer);
    writeFileSync(manifest.path, `${JSON.stringify(manifest.json, null, 2)}\n`);
    io.out(`✓ wrote ${manifest.path}`);
  }

  mkdirSync(dirname(join(appRoot, RESUME_MARKER)), { recursive: true });
  writeFileSync(join(appRoot, RESUME_MARKER), `${JSON.stringify({ from: installed, target })}\n`);
  if (!step(io, appRoot, "npm install", npmCommand(["install"]))) return 1;

  const after = readInstalledNotes(appRoot);
  if (after.kind === "broken") {
    io.err(`✗ oe upgrade: ${target} ships a ${NOTES_FILE} that does not parse, so its codemods, env names and manual steps cannot be read:`);
    for (const p of after.problems) io.err(`  - ${p}`);
    io.err(`  The packages are bumped and installed. Read ${target}'s UPGRADING.md by hand, then run \`oe build --accept\`, \`npm run typecheck\` and \`npm run build\`.`);
    return 1;
  }
  const windowAfter = after.kind === "ok" ? notesBetween(after.notes, installed, target) : [];
  if (after.kind === "absent") io.out(`· ${target} ships no ${NOTES_FILE} — it predates the release record. There are no codemods to run.`);
  else if (windowAfter.length === 0) io.out(`· ${target}'s ${NOTES_FILE} holds no entry above ${installed}. There are no codemods to run.`);
  else {
    io.out(`Release notes (${target}'s own copy):`);
    printWindow(io, windowAfter, installed, target);
  }
  const unknownAfter = unknownCodemods(windowAfter);
  if (unknownAfter.length > 0) {
    io.err(`✗ oe upgrade: ${target}'s release notes name ${unknownAfter.length} codemod(s) this CLI does not hold: ${unknownAfter.join(", ")}.`);
    io.err(`  The packages are bumped and installed. Apply those migrations by hand, then run \`oe build --accept\`, \`npm run typecheck\` and \`npm run build\`.`);
    return 1;
  }
  for (const release of windowAfter) {
    for (const migration of release.configMigrations) {
      if (migration.codemod === undefined) {
        io.out(`! ${release.version} CONFIG (apply by hand): ${migration.description}`);
        continue;
      }
      const codemod = codemodById(migration.codemod);
      if (codemod === undefined) {
        io.err(`✗ oe upgrade: codemod "${migration.codemod}" (${release.version}) vanished between the check and the run. Apply that migration by hand.`);
        return 1;
      }
      io.out(`→ codemod ${codemod.id} (${release.version})`);
      const changed = codemod.run(appRoot);
      if (changed.length === 0) io.out(`  · nothing to change — the tree already satisfies it`);
      for (const line of changed) io.out(`  · ${line}`);
    }
  }

  const oe = installedOeBin(appRoot);
  if (oe === undefined) {
    io.err(`✗ oe upgrade: the install left no \`oe\` bin under node_modules/${CORE}. The install did not complete.`);
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
