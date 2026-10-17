import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldApp } from "../packages/create/src/scaffold.js";
import { defaultAdapterWiring } from "../packages/adapters/agent/register-defaults.js";
import { assertCoreDistFresh, assertPackageDistFresh } from "./core-dist-freshness.js";
import { tsxCommand } from "./npm-command.js";

assertCoreDistFresh();
assertPackageDistFresh("packages/adapters", "@open-everywhere/adapters");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = (args: readonly string[]): [string, string[]] => tsxCommand(REPO, args);
const OE_CLI = join(REPO, "packages", "core", "scripts", "oe-cli.ts");
const WIRING_REL = "agent/lib/register-adapters.ts";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}

interface Wiring {
  readonly providers: readonly string[];
  readonly oeOauth: boolean;
  readonly dbCredentialBroker: boolean;
  readonly agentBrowser: boolean;
  readonly awsAccess: boolean;
  readonly customAdapters: boolean;
  readonly store: { readonly operational: { readonly id: string; readonly floor: string }; readonly neon: boolean; readonly pgliteFloor: boolean };
}
interface Boot {
  readonly wiring: Wiring | null;
  readonly table: readonly string[];
  readonly hookMarker: boolean;
  readonly secondCallReused: boolean;
  readonly neonQueries: number;
}

const PROBE = `
let neonQueries = 0;
if (process.argv.includes("--neon-pglite")) {
  const neon = (await import("@neondatabase/serverless")) as unknown as { Pool: { prototype: Record<string, unknown> } };
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  const run = async (text: string, params?: unknown[]) => {
    neonQueries++;
    const r = await pg.query(text, params as unknown[] | undefined);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  neon.Pool.prototype.query = (text: string, params?: unknown[]) => run(text, params);
  neon.Pool.prototype.connect = async () => ({ query: run, release: () => {} });
}
await import("./agent/lib/register-config.ts");
await import("./agent/lib/register-adapters.ts");
const { defaultAdapterWiring, registerDefaultAdapters } = await import("@open-everywhere/adapters/agent/register-defaults.js");
// Read BEFORE the probe's own call below, which would otherwise report itself.
const wiring = defaultAdapterWiring() ?? null;
const neonQueriesAtBoot = neonQueries;
// OPE-2346: eve 0.71 evaluates agent/agent.ts more than once in one build process, so a second call
// returns the first call's result rather than throwing. An EMPTY table here would re-declare the
// selection if the wiring ran again, so the same object back proves nothing re-ran.
let secondCallReused = false;
try {
  const again = await registerDefaultAdapters({ providers: [], memory: { domains: () => [], silos: () => [], grants: () => null } });
  secondCallReused = wiring !== null && again === wiring && defaultAdapterWiring() === wiring;
} catch {
  secondCallReused = false;
}
const { SELECTED_PROVIDERS } = await import("./agent/lib/providers.generated.ts");
const report = {
  wiring,
  table: SELECTED_PROVIDERS.map((p) => p.id),
  hookMarker: (globalThis as { __oeTemplateAdaptersHook?: boolean }).__oeTemplateAdaptersHook === true,
  secondCallReused,
  neonQueries: neonQueriesAtBoot,
};
console.log("OE_TEMPLATE_ADAPTERS=" + JSON.stringify(report));
process.exit(0);
`;

const scratch = mkdtempSync(join(tmpdir(), "oe-template-adapters-"));

function scaffold(name: string): string {
  const { dir } = scaffoldApp({ targetDir: join(scratch, name), version: "0.0.0-test", eol: "\n" });
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  execFileSync(...tsx([OE_CLI, "build"]), { cwd: dir, env: childEnv(dir, {}), stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(dir, "probe.ts"), PROBE);
  return dir;
}

function childEnv(dir: string, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const state = join(dir, ".test-state");
  mkdirSync(state, { recursive: true });
  return { ...env, NODE_NO_WARNINGS: "1", OE_PGLITE_DIR: join(state, "pglite"), OE_MEMORY_DIR: join(state, "memory"), ...extra };
}

function boot(dir: string, extra: Readonly<Record<string, string>> = {}, neonPglite = false): Boot {
  const out = execFileSync(...tsx(["probe.ts", ...(neonPglite ? ["--neon-pglite"] : [])]), { cwd: dir, env: childEnv(dir, extra), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const line = out.split("\n").find((l) => l.startsWith("OE_TEMPLATE_ADAPTERS="));
  assert.ok(line, `the probe printed no report in ${dir}`);
  return JSON.parse(line.slice("OE_TEMPLATE_ADAPTERS=".length)) as Boot;
}

function notThroughProduct(b: Boot): string | undefined {
  if (b.wiring === null) return "the app's register-adapters.ts never called registerDefaultAdapters()";
  if (JSON.stringify(b.wiring.providers) !== JSON.stringify([...b.table].sort())) return "the declared selection is not the generated table";
  return undefined;
}

function floorWiring(table: readonly string[]): Wiring {
  return {
    providers: [...table].sort(),
    oeOauth: true,
    dbCredentialBroker: false,
    agentBrowser: false,
    awsAccess: false,
    customAdapters: true,
    store: { operational: { id: "postgres", floor: "pglite" }, neon: false, pgliteFloor: true },
  };
}

function runModelCheck(dir: string): Promise<{ code: number | null; out: string; err: string }> {
  const line = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["check:model-config"];
  assert.ok(line?.startsWith("node "), `the scaffolded app ships a check:model-config script line, got ${JSON.stringify(line)}`);
  const [, ...args] = line.split(" ");
  return new Promise((done) => {
    const child = spawn(process.execPath, [...args, "--json"], { cwd: dir, env: childEnv(dir, {}), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("close", (code) => done({ code, out, err }));
  });
}

async function modelConfigArm(): Promise<void> {
  let region = "us";
  const asked: string[] = [];
  const stub = createServer((req, res) => {
    asked.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { endpoints: [{ provider_name: "stub", has_zdr: true, has_no_training: true, inference_regions: [{ geo_region: region }] }] } }));
  });
  await new Promise<void>((up) => stub.listen(0, "127.0.0.1", up));
  try {
    const port = (stub.address() as AddressInfo).port;
    const app = scaffold("model-check-app");
    const settingsRel = join("agent", "settings", "settings.ts");
    const settings = readFileSync(join(app, settingsRel), "utf8");
    const closer = "\n});\n";
    ok(settings.endsWith(closer) && settings.indexOf("defineSettings({") === settings.lastIndexOf("defineSettings({"), "F: fixture — the template's settings file ends its one defineSettings({ … }) call last");
    writeFileSync(
      join(app, settingsRel),
      `${settings.slice(0, -closer.length)}\n  models: { targets: { gateway: { kind: "vercel-ai-gateway", url: "http://127.0.0.1:${port}" } }, dataPolicy: { region: "eu" } },${closer}`,
    );

    const red = await runModelCheck(app);
    eq(red.code, 1, `🔴 F: under region eu, with every provider in us, the scaffolded app's check exits 1 — stdout: ${red.out.slice(0, 2000)} stderr: ${red.err.slice(-2000)}`);
    const redReport = JSON.parse(red.out) as { met: string; models: { id: string }[]; findings: { met: string; row: string; detail: string }[] };
    eq(redReport.met, "no", "F: …and its verdict is no");
    ok(redReport.findings.some((f) => f.met === "no" && f.row === "models.dataPolicy region eu" && /^region eu: no provider for /.test(f.detail)), "F: …and a finding names the region row and the model");
    ok(redReport.models.length > 0, "F: the check lists the app's resolvable models");
    for (const m of redReport.models) {
      ok(asked.some((u) => u === `/v1/models/${m.id}/endpoints`), `F: the check read ${m.id} through the app's own gateway target`);
    }

    region = "eu";
    const green = await runModelCheck(app);
    eq(green.code, 0, "F: NEGATIVE CONTROL — the same app exits 0 once a provider serves eu, so the red follows the settings");
    eq((JSON.parse(green.out) as { met: string }).met, "yes", "F: …and its verdict is yes");
  } finally {
    stub.close();
  }
}

eq(defaultAdapterWiring(), undefined, "importing register-defaults.js wires nothing on its own");

try {
  const current = scaffold("current-app");
  const a = boot(current);
  ok(a.table.length > 0, "A: the scaffolded app's generated table selects at least one provider bundle");
  eq(notThroughProduct(a), undefined, "🔴 A: the scaffolded app boots THROUGH registerDefaultAdapters(), with its generated table");
  eq(a.wiring, floorWiring(a.table), "A: bare env — the PGlite floor arms, the Neon gate stays shut, the template's hook runs");
  ok(a.secondCallReused, "A: a second registerDefaultAdapters() call in the same process returns the first call's wiring and runs nothing again — a re-run would re-declare the selection and re-run every bundle's register() (OPE-2346: eve 0.71 evaluates agent.ts more than once, so it does not throw)");

  const b = boot(current, { OE_OPERATIONAL_PROVIDER: "sqlite" });
  eq(notThroughProduct(b), undefined, "B: the sqlite selection boots through registerDefaultAdapters() too");
  eq(
    b.wiring?.store,
    { operational: { id: "sqlite", floor: "sqlite" }, neon: false, pgliteFloor: false },
    "B: OE_OPERATIONAL_PROVIDER=sqlite reaches the product's rule — no PGlite floor, no Neon",
  );

  const drifted = scaffold("drifted-app");
  const original = readFileSync(join(drifted, WIRING_REL), "utf8");
  const driftedWiring = [
    "// An OLDER header, edited by the operator, as an app keeps it after many upgrades.",
    'import { domainMemoryGrants } from "./memory-grants.js";',
    'import { loadDomains, loadSilos } from "../memory/config/domains.js";',
    'import { SELECTED_PROVIDERS } from "./providers.generated.js";',
    'import { registerDefaultAdapters } from "@open-everywhere/adapters/agent/register-defaults.js";',
    "",
    "await registerDefaultAdapters({",
    "  memory: { grants: domainMemoryGrants, silos: loadSilos, domains: loadDomains },",
    "  providers: SELECTED_PROVIDERS,",
    "  customAdapters: async () => {",
    "    (globalThis as { __oeTemplateAdaptersHook?: boolean }).__oeTemplateAdaptersHook = true;",
    "  },",
    "});",
    "",
  ].join("\n");
  ok(driftedWiring !== original, "C: fixture — the drifted copy differs from the template's bytes");
  writeFileSync(join(drifted, WIRING_REL), driftedWiring);
  const c = boot(drifted);
  ok(c.hookMarker, "C: the app's customAdapters hook runs");
  ok(!a.hookMarker, "C: negative control — the template's empty hook sets no marker");
  eq(c.wiring, a.wiring, "🔴 C: a drifted copy of the one-call file wires byte-identically to the current template");

  const handWired = scaffold("hand-wired-app");
  writeFileSync(
    join(handWired, WIRING_REL),
    [
      "// The pre-OPE-2301 shape: the app wires its adapters by hand, with the 0.1.2 Neon gate.",
      'import { declareProviderSelection, registerOperationalPgliteLazy } from "@open-everywhere/core/agent/adapter-api.js";',
      'import { registerNeon } from "@open-everywhere/adapters/agent/postgres/neon.js";',
      'import { SELECTED_PROVIDERS, SELECTED_PROVIDER_IDS } from "./providers.generated.js";',
      "",
      "declareProviderSelection(SELECTED_PROVIDER_IDS);",
      "for (const provider of SELECTED_PROVIDERS) provider.register();",
      'if ((process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") && process.env.DATABASE_URL) {',
      "  await registerNeon();",
      "}",
      "if (!process.env.OE_OPERATIONAL_PROVIDER && !process.env.DATABASE_URL) registerOperationalPgliteLazy();",
      "",
    ].join("\n"),
  );
  const d = boot(handWired);
  eq(d.wiring, null, "D: a hand-wired copy boots without the product's function");
  ok(!d.secondCallReused, "D: negative control — with no first call, the probe's own call is the FIRST wiring, not a reuse, so arm A's reuse row can fail");
  ok(
    notThroughProduct(d) === "the app's register-adapters.ts never called registerDefaultAdapters()",
    "🔴 D: NEGATIVE CONTROL — the check names a hand-wired copy, so arms A and C can fail",
  );

  const NEON_ENV = { DATABASE_URL: "postgres://app@db.invalid/app" };
  const neonStore = { operational: { id: "postgres", floor: "none" }, neon: true, pgliteFloor: false };
  const eCurrent = boot(current, NEON_ENV, true);
  eq(notThroughProduct(eCurrent), undefined, "E: DATABASE_URL only — the current template boots through registerDefaultAdapters()");
  eq(eCurrent.wiring?.store, neonStore, "E: DATABASE_URL only — the current template opens the Neon gate");
  ok(eCurrent.neonQueries > 0, `E: the Neon client answered the boot's queries (${eCurrent.neonQueries})`);
  const eDrifted = boot(drifted, NEON_ENV, true);
  eq(eDrifted.wiring, eCurrent.wiring, "🔴 E: the drifted copy wires byte-identically to the current template on DATABASE_URL alone");
  ok(eDrifted.neonQueries > 0, "E: the drifted copy registers the Neon client too");
  const eHand = boot(handWired, NEON_ENV, true);
  eq(eHand.wiring, null, "E: the hand-wired copy boots without the product's function");
  eq(eHand.neonQueries, 0, "🔴 E: the hand-wired 0.1.2 gate registers NO Postgres client on DATABASE_URL alone — the drift a one-call copy cannot carry");

  await modelConfigArm();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`template-adapters-boot-test: ${passed} assertions passed`);
