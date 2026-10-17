import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmCommand, npxCommand } from "./npm-command.js";
import { packPublishablePackages } from "./publish-pack.js";
import { compareVersions } from "../packages/core/scripts/upgrade-notes.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
  console.log(`  ✓ ${label}`);
};
const eq = <T>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
  console.log(`  ✓ ${label}`);
};

const REPO_ROOT = process.cwd();
const keep = process.argv.includes("--keep");
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const CHILD_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/AI_GATEWAY_API_KEY|AI_GATEWAY_KEY/.test(k) && k !== "VERCEL"),
);

function run(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = CHILD_ENV): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, [...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const npm = (args: readonly string[], cwd: string) => run(...npmCommand(args), cwd);
const npx = (args: readonly string[], cwd: string) => run(...npxCommand(args), cwd);
const tail = (out: string, lines = 60): string => out.trim().split("\n").slice(-lines).join("\n");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function binOf(root: string, pkg: string, bin: string): string {
  const manifest = join(root, "node_modules", ...pkg.split("/"), "package.json");
  const declared = readJson<{ bin?: string | Record<string, string> }>(manifest).bin;
  const rel = typeof declared === "string" ? declared : declared?.[bin];
  assert.ok(rel, `${pkg} declares a \`${bin}\` bin`);
  return join(root, "node_modules", ...pkg.split("/"), rel);
}

interface AppManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface Lockfile {
  packages: Record<string, { version?: string; resolved?: string }>;
}

function lockfileGaps(manifest: AppManifest, lock: Lockfile): string[] {
  const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  return declared.filter((name) => !(`node_modules/${name}` in lock.packages)).sort();
}

function rosterKeys(lock: { packages?: Record<string, { contributions?: Record<string, string> }> }): string[] {
  return Object.entries(lock.packages ?? {}).flatMap(([pkg, entry]) => Object.keys(entry.contributions ?? {}).map((c) => `${pkg} ${c}`));
}

const BOOT_PROBE = `import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const files = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
};
const modules = files(join(root, "agent")).sort();
const failures = [];
const loaded = new Map();
for (const f of modules) {
  const rel = relative(root, f).split(sep).join("/");
  try { loaded.set(rel, await import(pathToFileURL(f).href)); }
  catch (err) { failures.push(rel + ": " + String(err instanceof Error ? err.message : err).split("\\n")[0]); }
}
const agent = loaded.get("agent/agent.ts")?.default;
const model = agent?.model;
const seen = new Map();
const collisions = [];
let routes = 0;
for (const [rel, mod] of loaded) {
  const ch = mod.default;
  if (!rel.startsWith("agent/channels/") || ch?.__kind !== "eve:channel" || !Array.isArray(ch.routes)) continue;
  for (const r of ch.routes) {
    if (typeof r?.path !== "string") continue;
    routes++;
    const key = (r.transport ?? "http") + " " + (r.method ?? "GET") + " " + r.path;
    if (seen.has(key) && seen.get(key) !== rel) collisions.push(key + " (" + seen.get(key) + ", " + rel + ")");
    else seen.set(key, rel);
  }
}
console.log(JSON.stringify({
  modules: modules.length,
  failures,
  agent: typeof agent === "object" && agent !== null,
  dynamic: model?.kind === "eve:dynamic",
  stepScoped: model?.kind === "eve:dynamic" && Object.keys(model.events ?? {}).includes("step.started"),
  routes,
  collisions,
}));
process.exit(0);
`;

interface BootResult {
  modules: number;
  failures: string[];
  agent: boolean;
  dynamic: boolean;
  stepScoped: boolean;
  routes: number;
  collisions: string[];
}

function bootProbe(app: string, stateRoot: string): BootResult {
  const probe = join(app, "oe-rehearsal-boot-probe.mjs");
  writeFileSync(probe, BOOT_PROBE);
  mkdirSync(stateRoot, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...CHILD_ENV, OE_PGLITE_DIR: join(stateRoot, "pglite"), OE_MEMORY_DIR: join(stateRoot, "memory") };
  delete env.DATABASE_URL;
  const r = run(process.execPath, ["--import", "tsx", probe], app, env);
  rmSync(probe);
  assert.equal(r.code, 0, `the boot probe failed to run:\n${tail(r.out)}`);
  const line = r.out
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{"));
  assert.ok(line, `the boot probe printed no result:\n${tail(r.out)}`);
  return JSON.parse(line) as BootResult;
}

function assertBoot(result: BootResult, when: string): void {
  ok(result.modules > 0, `${when}: the boot probe found ${result.modules} module(s) under agent/`);
  eq(result.failures, [], `${when}: every module under agent/ loads (no module-load throw)`);
  ok(result.agent, `${when}: agent/agent.ts exports the agent definition`);
  ok(result.dynamic, `${when}: the agent's model is dynamic (the gateway resolver)`);
  ok(result.stepScoped, `${when}: the dynamic model is bound at step.started`);
  ok(result.routes > 0, `${when}: the channels declare ${result.routes} route(s)`);
  eq(result.collisions, [], `${when}: no two channels declare one route`);
}

function takesDockerBackend(settings: string | undefined): boolean {
  if (settings === undefined) return true;
  const code = settings.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return !/selfHostBackend:\s*"justbash"/.test(code);
}
assert.equal(takesDockerBackend('//   sandbox: { selfHostBackend: "justbash" },\nexport const S = defineSettings({});\n'), true);
assert.equal(takesDockerBackend('export const S = defineSettings({\n  sandbox: { selfHostBackend: "justbash" },\n});\n'), false);
assert.equal(takesDockerBackend(undefined), true);

function previousRelease(candidate: string): string {
  const view = npm(["view", "@open-everywhere/core", "versions", "--json"], REPO_ROOT);
  assert.equal(view.code, 0, `npm view @open-everywhere/core versions failed:\n${tail(view.out)}`);
  const parsed = JSON.parse(view.out) as string | string[];
  const published = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const below = published.filter((v) => compareVersions(v, candidate) < 0).sort(compareVersions);
  const previous = below.at(-1);
  assert.ok(previous, `the registry holds no @open-everywhere/core release below ${candidate} (published: ${published.join(", ")})`);
  return previous;
}

const CANDIDATE = readJson<{ version: string }>(join(REPO_ROOT, "packages", "core", "package.json")).version;
assert.ok(
  existsSync(join(REPO_ROOT, "packages", "core", "dist", "agent")),
  "packages/core/dist is missing — run `npm run build:packages` first: a pack ships whatever dist/ is on disk",
);

const scratch = mkdtempSync(join(tmpdir(), "oe-upgrade-rehearsal-"));
const app = join(scratch, "app");
try {
  console.log("1. the versions");
  const PREVIOUS = flag("previous") ?? previousRelease(CANDIDATE);
  ok(compareVersions(PREVIOUS, CANDIDATE) < 0, `the previous release ${PREVIOUS} is below the candidate ${CANDIDATE}`);

  console.log(`2. install @open-everywhere/create@${PREVIOUS} from the registry and scaffold app/`);
  const cliDir = join(scratch, "cli");
  mkdirSync(cliDir);
  writeFileSync(join(cliDir, "package.json"), `${JSON.stringify({ name: "oe-rehearsal-host", version: "1.0.0", private: true }, null, 2)}\n`);
  const cliInstall = npm(["install", "--no-audit", "--no-fund", "--loglevel", "error", `@open-everywhere/create@${PREVIOUS}`], cliDir);
  assert.equal(cliInstall.code, 0, `installing @open-everywhere/create@${PREVIOUS} failed:\n${tail(cliInstall.out)}`);
  const scaffold = run(process.execPath, [binOf(cliDir, "@open-everywhere/create", "create-open-everywhere"), "app"], scratch);
  assert.equal(scaffold.code, 0, `@open-everywhere/create@${PREVIOUS} app failed:\n${tail(scaffold.out)}`);
  ok(existsSync(join(app, "agent", "agent.ts")) && existsSync(join(app, "roster.lock.json")), `the ${PREVIOUS} scaffolder wrote app/ (agent/agent.ts, roster.lock.json)`);
  const scaffolded = readJson<AppManifest>(join(app, "package.json"));
  eq(scaffolded.dependencies?.["@open-everywhere/core"], PREVIOUS, `the app pins @open-everywhere/core to ${PREVIOUS}`);
  const settingsPath = join(app, "agent", "settings", "settings.ts");
  const takesDocker = takesDockerBackend(existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined);
  if (takesDocker) {
    assert.equal(
      run("docker", ["info"], REPO_ROOT).code,
      0,
      `no Docker daemon answers \`docker info\`. The ${PREVIOUS} app takes the \`docker\` sandbox backend, and its \`eve build\` provisions the sandbox template there. Start the daemon and run again`,
    );
    n++;
    console.log("  ✓ a Docker daemon answers (the app takes the `docker` sandbox backend)");
  } else {
    console.log("  · the app declares the `justbash` sandbox backend, so the build needs no Docker daemon");
  }

  console.log(`3. npm install the app at ${PREVIOUS} and prove the baseline`);
  const install = npm(["install", "--no-audit", "--no-fund", "--loglevel", "error", "--foreground-scripts"], app);
  assert.equal(install.code, 0, `npm install at ${PREVIOUS} failed:\n${tail(install.out)}`);
  eq(readJson<{ version: string }>(join(app, "node_modules", "@open-everywhere", "core", "package.json")).version, PREVIOUS, `core is installed at ${PREVIOUS}`);
  const baseBuild = npm(["run", "oe:build"], app);
  assert.equal(baseBuild.code, 0, `npm run oe:build at ${PREVIOUS} failed:\n${tail(baseBuild.out)}`);
  const baseCheck = run(process.execPath, [binOf(app, "@open-everywhere/core", "oe"), "build", "--check"], app);
  eq(baseCheck.code, 0, `BASELINE: \`oe build --check\` passes at ${PREVIOUS}${baseCheck.code === 0 ? "" : `:\n${tail(baseCheck.out)}`}`);
  assertBoot(bootProbe(app, join(scratch, "state-baseline")), `BASELINE at ${PREVIOUS}`);
  const baselineRoster = new Set(rosterKeys(readJson(join(app, "roster.lock.json"))));

  console.log(`4. pack the candidate ${CANDIDATE}`);
  const tarballs = join(scratch, "release");
  const packed = packPublishablePackages(REPO_ROOT, tarballs);
  ok(packed.length > 0, `packed ${packed.length} publishable packages into the release directory`);

  console.log(`5. npx oe upgrade --from <release>  (${PREVIOUS} → ${CANDIDATE}, minutes)`);
  const plan = npx(["oe", "upgrade", "--plan", "--from", tarballs], app);
  eq(plan.code, 0, `\`npx oe upgrade --plan --from <release>\` exits 0${plan.code === 0 ? "" : `:\n${tail(plan.out)}`}`);
  const upgrade = npx(["oe", "upgrade", "--from", tarballs], app);
  console.log(
    upgrade.out
      .split("\n")
      .filter((l) => /^\s*(?:[✓✗!·]|step|\d\.)/u.test(l))
      .slice(0, 40)
      .map((l) => `    | ${l}`)
      .join("\n"),
  );
  eq(upgrade.code, 0, `\`npx oe upgrade --from <release>\` exits 0 (the seven steps)${upgrade.code === 0 ? "" : `:\n${tail(upgrade.out)}`}`);

  console.log("6. the lockfile: package.json and package-lock.json agree, and `npm ci` installs them");
  const manifestPath = join(app, "package.json");
  const lockPath = join(app, "package-lock.json");
  const upgradedManifestText = readFileSync(manifestPath, "utf8");
  const upgraded = JSON.parse(upgradedManifestText) as AppManifest;
  eq(lockfileGaps(upgraded, readJson<Lockfile>(lockPath)), [], "every dependency the upgraded package.json declares has a lockfile entry");
  const declared = new Set([...Object.keys(upgraded.dependencies ?? {}), ...Object.keys(upgraded.devDependencies ?? {})]);
  const injected = packed.find((p) => p.name === "@open-everywhere/provider-google-chat" && !declared.has(p.name)) ?? packed.find((p) => !declared.has(p.name));
  if (injected) {
    try {
      const withExtra: AppManifest = { ...upgraded, dependencies: { ...upgraded.dependencies, [injected.name]: `file:${injected.tarball.split("\\").join("/")}` } };
      writeFileSync(manifestPath, `${JSON.stringify(withExtra, null, 2)}\n`);
      eq(lockfileGaps(withExtra, readJson<Lockfile>(lockPath)), [injected.name], `🔴 NEGATIVE CONTROL: ${injected.name} in package.json with no lockfile entry is a lockfile gap`);
      const ciRed = npm(["ci", "--no-audit", "--no-fund", "--loglevel", "error"], app);
      ok(
        ciRed.code !== 0 && /in sync/.test(ciRed.out) && ciRed.out.includes(injected.name),
        `🔴 NEGATIVE CONTROL: \`npm ci\` refuses package.json and a lockfile that lacks ${injected.name}, and says they are not in sync`,
      );
    } finally {
      writeFileSync(manifestPath, upgradedManifestText);
    }
  } else {
    console.log("  · every packed package is already declared, so the lockfile control drops a lockfile entry instead");
    const lockText = readFileSync(lockPath, "utf8");
    try {
      const lock = JSON.parse(lockText) as Lockfile;
      delete lock.packages["node_modules/@open-everywhere/core"];
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      eq(lockfileGaps(upgraded, lock), ["@open-everywhere/core"], "🔴 NEGATIVE CONTROL: a lockfile with no core entry is a lockfile gap");
      const ciRed = npm(["ci", "--no-audit", "--no-fund", "--loglevel", "error"], app);
      ok(
        ciRed.code !== 0 && /in sync/.test(ciRed.out) && ciRed.out.includes("@open-everywhere/core"),
        "🔴 NEGATIVE CONTROL: `npm ci` refuses a lockfile that lacks core, and says they are not in sync",
      );
    } finally {
      writeFileSync(lockPath, lockText);
    }
  }
  const ci = npm(["ci", "--no-audit", "--no-fund", "--loglevel", "error", "--foreground-scripts"], app);
  eq(ci.code, 0, `the deploy install: \`npm ci\` from the upgraded package.json and lockfile exits 0${ci.code === 0 ? "" : `:\n${tail(ci.out)}`}`);
  eq(readJson<{ version: string }>(join(app, "node_modules", "@open-everywhere", "core", "package.json")).version, CANDIDATE, `core is installed at the candidate ${CANDIDATE}`);
  const npmLs = npm(["ls", "--all", "--parseable"], app);
  eq(npmLs.code, 0, `\`npm ls --all\` exits 0 (no missing, invalid or extraneous package)${npmLs.code === 0 ? "" : `:\n${tail(npmLs.out)}`}`);

  console.log("7. the roster: roster.lock.json names every roster name the candidate offers");
  const oe = binOf(app, "@open-everywhere/core", "oe");
  const rosterPath = join(app, "roster.lock.json");
  const rosterText = readFileSync(rosterPath, "utf8");
  const added = rosterKeys(JSON.parse(rosterText)).filter((k) => !baselineRoster.has(k));
  console.log(`  · the upgrade accepted ${added.length} new roster name(s)${added.length ? `: ${added.join(", ")}` : ""}`);
  const pick = added.find((k) => k.endsWith(" tool/look_up")) ?? added[0] ?? rosterKeys(JSON.parse(rosterText))[0];
  assert.ok(pick, "roster.lock.json names no contribution at all");
  const [pickPkg, pickName] = pick.split(" ") as [string, string];
  try {
    const roster = JSON.parse(rosterText) as { packages: Record<string, { contributions: Record<string, string> }> };
    delete roster.packages[pickPkg]!.contributions[pickName];
    writeFileSync(rosterPath, `${JSON.stringify(roster, null, 2)}\n`);
    const red = run(process.execPath, [oe, "build", "--check"], app);
    ok(red.code !== 0, `🔴 NEGATIVE CONTROL: \`oe build --check\` is red when roster.lock.json lacks ${pickName}`);
    const [pickKind, pickBare] = pickName.split("/") as [string, string];
    ok(red.out.includes(`${pickKind} "${pickBare}"`) && red.out.includes("UNREVIEWED"), `…and the refusal names ${pickKind} "${pickBare}" as UNREVIEWED`);
  } finally {
    writeFileSync(rosterPath, rosterText);
  }
  const check = run(process.execPath, [oe, "build", "--check"], app);
  eq(check.code, 0, `\`oe build --check\` passes on the upgraded app${check.code === 0 ? "" : `:\n${tail(check.out)}`}`);

  console.log("8. npm run typecheck");
  const tsc = npm(["run", "typecheck"], app);
  eq(tsc.code, 0, `the upgraded app typechecks${tsc.code === 0 ? "" : `:\n${tail(tsc.out)}`}`);

  console.log("9. npm run build (oe build, then eve build — minutes)");
  const build = npm(["run", "build"], app);
  eq(build.code, 0, `\`npm run build\` succeeds in the upgraded app${build.code === 0 ? "" : `:\n${tail(build.out)}`}`);
  ok(existsSync(join(app, ".output", "server")), "eve build wrote .output/server");
  eq(readFileSync(rosterPath, "utf8"), rosterText, "the build's `oe build` left roster.lock.json as the upgrade accepted it");

  console.log("10. the boot probe on the upgraded app");
  assertBoot(bootProbe(app, join(scratch, "state-upgraded")), `UPGRADED to ${CANDIDATE}`);
  const thrower = join(app, "agent", "oe-rehearsal-throws.ts");
  try {
    writeFileSync(thrower, 'throw new Error("oe-rehearsal: a module-load throw");\n');
    const red = bootProbe(app, join(scratch, "state-control"));
    ok(red.failures.length === 1 && red.failures[0]!.startsWith("agent/oe-rehearsal-throws.ts:"), "🔴 NEGATIVE CONTROL: the boot probe is red on a module that throws at load, and names it");
  } finally {
    rmSync(thrower, { force: true });
  }

  console.log(`\n✓ upgrade rehearsal: ${n} assertions passed — an app scaffolded on ${PREVIOUS} takes ${CANDIDATE} with \`oe upgrade --from\`, then installs with \`npm ci\`, checks its roster, typechecks, builds and boots\n`);
} finally {
  if (keep) console.log(`\n(--keep) the rehearsal app is at ${app}`);
  else rmSync(scratch, { recursive: true, force: true });
}
