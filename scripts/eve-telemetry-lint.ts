import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWITCH = "EVE_TELEMETRY_DISABLED=1";

const PACKAGE_FILES = ["package.json", "packages/create/template/package.json"] as const;
const DOCKERFILES = ["Dockerfile", "packages/create/template/Dockerfile"] as const;
const SPAWN_ROOTS = ["scripts", "tests", "packages/create/template/scripts"] as const;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function eveCommands(script: string): { readonly prefix: readonly string[]; readonly command: string }[] {
  const found: { prefix: string[]; command: string }[] = [];
  for (const part of script.split(/&&|\|\||;/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const prefix: string[] = [];
    for (;;) {
      const word = words[0];
      if (word === undefined) break;
      if (ASSIGNMENT.test(word)) prefix.push(words.shift()!);
      else if (word === "env" || word === "cross-env" || word === "npx" || word === "node") words.shift();
      else if (word === "npm" && words[1] === "exec") words.splice(0, 2);
      else if (word.startsWith("-")) words.shift();
      else break;
    }
    const command = words[0];
    if (command !== undefined && (/^eve(@\S+)?$/.test(command) || /(^|\/)eve\/bin\/eve\.js$/.test(command))) found.push({ prefix, command: part.trim() });
  }
  return found;
}

function scriptsMissingSwitch(scripts: Readonly<Record<string, string>>): string[] {
  const missing: string[] = [];
  for (const [name, script] of Object.entries(scripts)) {
    for (const { prefix, command } of eveCommands(script)) {
      if (!prefix.includes(SWITCH)) missing.push(`${name}: ${command}`);
    }
  }
  return missing;
}

function stagesMissingSwitch(dockerfile: string): string[] {
  const missing: string[] = [];
  let stage: string | undefined;
  let declared = false;
  const close = (): void => {
    if (stage !== undefined && !declared) missing.push(stage);
  };
  for (const raw of dockerfile.split("\n")) {
    const line = raw.trim();
    if (/^FROM\s/i.test(line)) {
      close();
      stage = line;
      declared = false;
    } else if (/^ENV\s/i.test(line) && /(^|\s)EVE_TELEMETRY_DISABLED=("1"|1)(\s|$)/.test(line.slice(4))) {
      declared = true;
    }
  }
  close();
  return missing;
}

function sourceSpawnsEveWithoutSwitch(text: string): boolean {
  const spawnsEve =
    /\[\s*["'`]eve["'`]\s*,\s*["'`][a-z]/.test(text) ||
    /eve\/bin\/eve\.js/.test(text) ||
    /["'`]eve["'`]\s*,\s*["'`]eve["'`]/.test(text);
  return spawnsEve && !text.includes("EVE_TELEMETRY_DISABLED");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

ok(scriptsMissingSwitch({ dev: "eve dev" }).length === 1, "tier 1: a bare `eve dev` script is refused (negative control)");
ok(
  scriptsMissingSwitch({ build: "NODE_OPTIONS=--max-old-space-size=6144 eve build" }).length === 1,
  "tier 1: an env prefix without the switch is refused (negative control)",
);
for (const script of ["npx eve start", "npx eve@0.71.0 dev", "npx -p eve@0.71.0 eve dev","npx -y eve info", "npx --yes eve info", "npm exec eve -- info", "npm exec -- eve info", "env X=1 eve dev", "cross-env X=1 eve dev", "node node_modules/eve/bin/eve.js build", "./node_modules/eve/bin/eve.js build"]) {
  ok(scriptsMissingSwitch({ x: script }).length === 1, `tier 1: \`${script}\` without the switch is refused (negative control)`);
}
ok(
  scriptsMissingSwitch({ x: `${SWITCH} eve build && eve info` }).length === 1,
  "tier 1: the switch on the first command of a chain does not cover the second (negative control)",
);
ok(
  scriptsMissingSwitch({ dev: `${SWITCH} eve dev`, build: `NODE_OPTIONS=x ${SWITCH} eve build`, a: `env ${SWITCH} npx -y eve info`, b: `cross-env ${SWITCH} eve dev` }).length === 0,
  "tier 1: a script with the switch passes",
);
ok(
  scriptsMissingSwitch({ postinstall: "oe-eve-patch", prebuild: "tsx scripts/eve-build-stamp.ts begin", c: "npx eve-other x" }).length === 0,
  "tier 1: a script that only names eve in a word is not an eve command",
);
ok(
  stagesMissingSwitch(`FROM a AS build\nENV ${SWITCH}\nRUN npm run build\nFROM a AS runtime\nCMD ["npx", "eve", "start"]\n`).length === 1,
  "tier 1: a Dockerfile stage without the ENV is refused (negative control)",
);
ok(stagesMissingSwitch(`FROM a\nENV EVE_TELEMETRY_DISABLED=0\n`).length === 1, "tier 1: a stage that sets the switch to another value is refused (negative control)");
ok(stagesMissingSwitch(`FROM a AS build\nENV ${SWITCH}\nFROM a AS runtime\nENV NODE_ENV=production ${SWITCH}\n`).length === 0, "tier 1: every stage with the ENV passes");
ok(sourceSpawnsEveWithoutSwitch(`const [npx, args] = npxCommand(["eve", "build"]);`), "tier 1: a source file that spawns `eve build` without the switch is refused (negative control)");
ok(sourceSpawnsEveWithoutSwitch(`spawnSync(process.execPath, ["node_modules/eve/bin/eve.js"])`), "tier 1: a source file that runs eve/bin/eve.js without the switch is refused (negative control)");
ok(
  sourceSpawnsEveWithoutSwitch(`const eve = run(process.execPath, [binOf(app, "eve", "eve"), "build"], app);`),
  "tier 1: a source file that resolves the eve bin with `binOf` and builds without the switch is refused (negative control)",
);
ok(!sourceSpawnsEveWithoutSwitch(`npxCommand(["eve", "build"]); env: { EVE_TELEMETRY_DISABLED: "1" }`), "tier 1: a source file that spawns eve with the switch passes");
ok(!sourceSpawnsEveWithoutSwitch(`for (const dep of ["eve", ...deps])`), "tier 1: a list that only names the eve package is not a spawn");

for (const file of PACKAGE_FILES) {
  const scripts = (JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const eveScripts = Object.values(scripts).filter((s) => eveCommands(s).length > 0);
  ok(eveScripts.length > 0, `tier 2: ${file} has scripts that start eve (the rule has something to check)`);
  const missing = scriptsMissingSwitch(scripts);
  ok(missing.length === 0, `tier 2: ${file}: every script that runs eve sets ${SWITCH}. Missing:\n  ${missing.join("\n  ")}`);
}
for (const file of DOCKERFILES) {
  const missing = stagesMissingSwitch(readFileSync(join(ROOT, file), "utf8"));
  ok(missing.length === 0, `tier 2: ${file}: every stage declares ENV ${SWITCH}. Missing:\n  ${missing.join("\n  ")}`);
}
const spawnRoots = [...SPAWN_ROOTS, ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/scripts`), ...readdirSync(join(ROOT, "packages/providers")).map((p) => `packages/providers/${p}/scripts`)];
const scanned: string[] = [];
for (const root of spawnRoots) {
  try {
    scanned.push(...sourceFiles(join(ROOT, root)));
  } catch {
  }
}
ok(scanned.some((f) => relative(ROOT, f) === "tests/integration/prepare.ts"), "tier 2: the source scan reaches tests/integration/prepare.ts, the integration tier's `eve build`");
const unswitched = scanned.filter((f) => sourceSpawnsEveWithoutSwitch(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
ok(unswitched.length === 0, `tier 2: every source file that spawns eve names EVE_TELEMETRY_DISABLED. Missing:\n  ${unswitched.join("\n  ")}`);

const eveBin = join(ROOT, "node_modules/eve/bin/eve.js");
function eveVersionStderr(extra: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "oe-eve-telemetry-"));
  let run: SpawnSyncReturns<string>;
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env })) {
      if (v !== undefined && !/^EVE_TELEMETRY_/.test(k) && k !== "NODE_ENV" && k !== "CI") env[k] = v;
    }
    Object.assign(
      env,
      {
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        APPDATA: join(home, "appdata"),
        NODE_ENV: "production",
        EVE_TELEMETRY_DEBUG: "1",
        EVE_TELEMETRY_ENDPOINT: "http://127.0.0.1:9/",
      },
      extra,
    );
    run = spawnSync(process.execPath, [eveBin, "--version"], { cwd: home, env, encoding: "utf8", timeout: 60_000 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  ok(run.status === 0, `tier 3: \`eve --version\` exits 0 (status ${run.status}, stderr: ${run.stderr?.slice(0, 300)})`);
  return run.stderr;
}
ok(
  eveVersionStderr({}).includes("[eve telemetry]"),
  "tier 3: without the switch, the installed eve prints its telemetry payload under EVE_TELEMETRY_DEBUG=1 (positive control). " +
    "If this fails after an eve bump, eve changed its telemetry: read node_modules/eve/dist/src/cli/telemetry/ and update this arm, the Dockerfiles, the scripts and docs/deploy/telemetry.md.",
);
ok(
  !eveVersionStderr({ EVE_TELEMETRY_DISABLED: "1" }).includes("[eve telemetry]"),
  `tier 3: with ${SWITCH}, the installed eve collects no telemetry`,
);

console.log(`✓ eve-telemetry: ${passed} checks — every eve start point sets ${SWITCH}, and the installed eve honours it`);
