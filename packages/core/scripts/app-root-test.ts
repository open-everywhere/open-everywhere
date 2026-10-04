// proves: ENV-150, ENV-151

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT_ENV, resolveAppRoot } from "../agent/scaffold/app-root.js";
import { loadAppDomains, loadAppSpendBudgets } from "./e2e/app-config.js";
import { loadConfigRooms } from "./e2e/fixture-inventory.js";
import { CAP_FIXTURES, resolveCapFixtureCap } from "./e2e/fixture-inventory-lib.js";

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function writeApp(dir: string, domainNames: readonly string[], capKey = "slack/T0EXAMPLE/C0EXCHAN007"): void {
  mkdirSync(join(dir, "agent", "memory", "config"), { recursive: true });
  mkdirSync(join(dir, "agent", "access"), { recursive: true });
  mkdirSync(join(dir, "agent", "spend"), { recursive: true });
  const budgets = { perSurface: { [capKey]: { surfaceMonthlyTokens: 10_000 } } };
  writeFileSync(join(dir, "agent", "spend", "budgets.ts"), `export function loadSpendBudgets() { return ${JSON.stringify(budgets)}; }\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", private: true, type: "module" }));
  writeFileSync(join(dir, "agent", "agent.ts"), "export default {};\n");
  const domains = domainNames.map((name) => ({ name, surfaces: [] }));
  writeFileSync(join(dir, "agent", "memory", "config", "domains.ts"), `export function loadDomains() { return ${JSON.stringify(domains)}; }\n`);
  writeFileSync(join(dir, "agent", "access", "bundles.ts"), "export function loadBundles() { return []; }\nexport function loadBindings() { return []; }\n");
}

const names = (domains: readonly unknown[]): string[] => domains.map((d) => (d as { name: string }).name);

const tmp = mkdtempSync(join(tmpdir(), "oe-app-root-"));
try {
  const consumer = join(tmp, "consumer");
  const product = join(consumer, "product");
  const productCore = join(product, "packages", "core");
  const elsewhere = join(tmp, "elsewhere");
  const noApp = join(tmp, "no-app", "deep");
  writeApp(consumer, ["reference", "consumer-only"], "slack/T_REAL/C_REAL_CAP");
  writeApp(product, ["reference"]);
  mkdirSync(productCore, { recursive: true });
  writeFileSync(join(productCore, "package.json"), JSON.stringify({ name: "@open-everywhere/core", private: true }));
  writeApp(elsewhere, ["elsewhere-only"]);
  mkdirSync(noApp, { recursive: true });

  const workspaceEnv = { INIT_CWD: consumer, npm_package_json: join(productCore, "package.json") };

  console.log("resolveAppRoot");
  check("the workspace form resolves the CONSUMER's root, where the operator ran npm", () => {
    assert.equal(resolveAppRoot({ env: workspaceEnv, cwd: productCore }), consumer);
  });
  check("NEGATIVE CONTROL: without the npm env, a walk from the core package finds the product first", () => {
    assert.equal(resolveAppRoot({ env: {}, cwd: productCore }), product);
  });
  check("a NESTED npm run resolves from the innermost call: npm reset INIT_CWD to the core package, so the walk finds the product", () => {
    const nested = { INIT_CWD: productCore, npm_package_json: join(productCore, "package.json") };
    assert.equal(resolveAppRoot({ env: nested, cwd: productCore }), product);
  });
  check("an inherited INIT_CWD does not pull a child that runs in another tree (config-diff's base checkout)", () => {
    const inherited = { INIT_CWD: consumer, npm_package_json: join(consumer, "package.json") };
    assert.equal(resolveAppRoot({ env: inherited, cwd: elsewhere }), elsewhere);
  });
  check("OE_APP_ROOT wins over the walk", () => {
    assert.equal(resolveAppRoot({ env: { ...workspaceEnv, [APP_ROOT_ENV]: elsewhere }, cwd: productCore }), elsewhere);
  });
  check("a relative OE_APP_ROOT is refused", () => {
    assert.throws(() => resolveAppRoot({ env: { [APP_ROOT_ENV]: "consumer" }, cwd: tmp }), /not an absolute path/);
  });
  check("an OE_APP_ROOT that is not an app is refused", () => {
    assert.throws(() => resolveAppRoot({ env: { [APP_ROOT_ENV]: noApp }, cwd: tmp }), /not an Open Everywhere app/);
  });
  check("a cwd with no app at or above it fails loud and names both options", () => {
    assert.throws(
      () => resolveAppRoot({ env: {}, cwd: noApp }),
      (err: unknown) => err instanceof Error && err.message.includes(APP_ROOT_ENV) && err.message.includes("Run from inside the app"),
    );
  });
  check("a cwd below this repository's root resolves this repository's root", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..", "..");
    assert.equal(resolveAppRoot({ env: {}, cwd: here }), repoRoot);
  });

  console.log("app config loads from the resolved root");
  await checkAsync("fixture-inventory's domain load returns the consumer's domains under OE_APP_ROOT", async () => {
    const previous = process.env[APP_ROOT_ENV];
    process.env[APP_ROOT_ENV] = consumer;
    try {
      const { domains, bindings } = await loadConfigRooms();
      assert.deepEqual(names(domains), ["reference", "consumer-only"]);
      assert.deepEqual(bindings, []);
    } finally {
      if (previous === undefined) delete process.env[APP_ROOT_ENV];
      else process.env[APP_ROOT_ENV] = previous;
    }
  });
  await checkAsync("NEGATIVE CONTROL: the product's reference app does not declare the consumer-only domain", async () => {
    const { domains } = await loadConfigRooms(product);
    assert.equal(names(domains).includes("consumer-only"), false);
    assert.deepEqual(names(domains), ["reference"]);
  });
  await checkAsync("rotate-window's domain load (loadAppDomains) resolves a domain that exists only in the consumer", async () => {
    const root = resolveAppRoot({ env: workspaceEnv, cwd: productCore });
    assert.equal(names(await loadAppDomains(root)).includes("consumer-only"), true);
    assert.equal(names(await loadAppDomains(product)).includes("consumer-only"), false);
  });

  const [capFixture] = CAP_FIXTURES;
  const testBedEnv = { E2E_SLACK_CAP_CHANNEL: "C_REAL_CAP" };
  await checkAsync("🔴 OPE-2205: S10's cap key resolves from the CONSUMER's budgets to the real room the test deployment drives", async () => {
    const root = resolveAppRoot({ env: workspaceEnv, cwd: productCore });
    assert.deepEqual(resolveCapFixtureCap(capFixture!, "T_REAL", await loadAppSpendBudgets(root), testBedEnv)?.caps, { surfaceMonthlyTokens: 10_000 });
  });
  await checkAsync("🔴 OPE-2205 NEGATIVE CONTROL: the product's own budgets name only the synthetic key, so they cap nothing the test deployment drives", async () => {
    assert.equal(resolveCapFixtureCap(capFixture!, "T_REAL", await loadAppSpendBudgets(product), testBedEnv)?.caps, undefined);
  });
  await checkAsync("an app with NO agent/spend/budgets.ts loads as empty budgets — the hook is optional, so S10 skips rather than crashing", async () => {
    rmSync(join(elsewhere, "agent", "spend", "budgets.ts"));
    assert.deepEqual(await loadAppSpendBudgets(elsewhere), {});
  });
  await checkAsync("NEGATIVE CONTROL: a budgets.ts that FAILS to load still throws — only the missing file maps to empty", async () => {
    writeFileSync(join(elsewhere, "agent", "spend", "budgets.ts"), 'import "./no-such-helper.js";\nexport function loadSpendBudgets() { return {}; }\n');
    await assert.rejects(loadAppSpendBudgets(elsewhere));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

await checkAsync("the reference app's budgets.ts caps the reference cap channel under the key S10 resolves", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const budgets = await loadAppSpendBudgets(repoRoot);
  assert.notEqual(resolveCapFixtureCap(CAP_FIXTURES[0]!, "T0EXAMPLE", budgets, { E2E_SLACK_CAP_CHANNEL: "C0EXCHAN007" })?.caps, undefined);
});

console.log(`✓ app-root: ${passed} checks passed`);
