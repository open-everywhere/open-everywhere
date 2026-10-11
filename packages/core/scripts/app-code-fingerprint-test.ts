process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_CODE_FINGERPRINT_MODULE,
  appCodeFiles,
  computeAppCodeFingerprint,
  renderAppCodeFingerprintModule,
  writeAppCodeFingerprint,
} from "./code-fingerprint.js";
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { RUNTIME_CODE_FINGERPRINT, runningCodeFingerprint } from "@open-everywhere/core/agent/channels/runtime-rotation.js";
import { getOrCreateDmSeat } from "@open-everywhere/core/agent/channels/dm-seat.js";
import { dmWindowRegistryKey } from "@open-everywhere/core/agent/channels/unified-supervisor.js";
import { resolveWorkGeneration } from "@open-everywhere/core/agent/channels/work-generation.js";
import { registerAppCodeFingerprint, resetAppCodeFingerprintForTest } from "@open-everywhere/core/agent/channels/app-code-fingerprint.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const SCRATCH = join(REPO_ROOT, "node_modules", ".oe-scratch", `app-code-fingerprint-${process.pid}`);
const makeApp = (name: string, files: readonly (readonly [string, string])[]): string => {
  const root = join(SCRATCH, name);
  for (const [rel, body] of files) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
};

const APP_FILES: readonly (readonly [string, string])[] = [
  ["package.json", '{ "name": "scratch-app", "private": true, "type": "module" }\n'],
  ["roster.config.ts", "export default { providers: { slack: true } };\n"],
  ["roster.lock.json", '{ "version": 1 }\n'],
  ["agent/agent.ts", "export default {};\n"],
  ["agent/instructions.md", "You are the agent.\n"],
  ["agent/subagents/review/instructions.md", "You review.\n"],
  ["agent/access/a2a-agents.ts", "export const A2A_AGENTS = [];\n"],
  ["agent/settings/settings.ts", "export const SETTINGS_OVERRIDES = {};\n"],
  ["agent/memory/config/domains/payments.ts", "export default { name: 'payments' };\n"],
  ["agent/access/a2a-agents-test.ts", "export const t = 1;\n"],
  ["patches/eve+0.0.0.patch", "diff --git a\n"],
];

try {
  {
    const app = makeApp("walk", APP_FILES);
    const write = (rel: string, body: string): void => {
      const abs = join(app, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    };
    const baseline = computeAppCodeFingerprint(app, "agent");
    ok(/^[0-9a-f]{16}$/.test(baseline), "control: the synthetic app hashes to a real 16-hex digest");
    const files = appCodeFiles(app, "agent");
    for (const inFile of ["agent/agent.ts", "agent/access/a2a-agents.ts", "agent/settings/settings.ts", "agent/instructions.md", "agent/subagents/review/instructions.md", "roster.config.ts", "roster.lock.json", "patches/eve+0.0.0.patch"]) {
      ok(files.includes(inFile), `🔴 ${inFile} is IN the app hash — it changes what a seat runs`);
    }
    ok(!files.some((f) => f.startsWith("agent/memory/config/domains/")), "🔴 the per-domain declarations are OUT — the seat's domain fingerprint covers them");
    ok(!files.some((f) => f.endsWith("-test.ts")), "…and tests are OUT");
    eq([...files], [...files].sort(), "🔴 the walk returns its paths SORTED");

    eq(computeAppCodeFingerprint(app, "agent"), baseline, "🔴 IDENTICAL REDEPLOY: a second build of the same tree yields the same fingerprint");
    const reordered = makeApp("walk-reordered", [...APP_FILES].reverse());
    eq(computeAppCodeFingerprint(reordered, "agent"), baseline, "🔴 …and the same files written in the OPPOSITE order hash the same, so two builds of one commit never disagree");

    write("agent/access/a2a-agents.ts", "export const A2A_AGENTS = [{ name: 'reference' }];\n");
    ok(computeAppCodeFingerprint(app, "agent") !== baseline, "🔴 OPE-2466: declaring an A2A agent in the APP moves the app fingerprint");
    write("agent/access/a2a-agents.ts", "export const A2A_AGENTS = [];\n");
    eq(computeAppCodeFingerprint(app, "agent"), baseline, "…and restoring it moves it BACK, so a rollback of an app change rotates too");

    for (const [rel, body] of [
      ["roster.lock.json", '{ "version": 2 }\n'],
      ["agent/instructions.md", "You are a different agent.\n"],
      ["agent/subagents/review/instructions.md", "You review harder.\n"],
      ["patches/eve+0.0.0.patch", "diff --git b\n"],
      ["agent/settings/settings.ts", "export const SETTINGS_OVERRIDES = { x: 1 };\n"],
    ] as const) {
      const before = readFileSync(join(app, rel), "utf8");
      write(rel, body);
      ok(computeAppCodeFingerprint(app, "agent") !== baseline, `🔴 an edit to ${rel} moves the app fingerprint`);
      write(rel, before);
    }
    eq(computeAppCodeFingerprint(app, "agent"), baseline, "control: every edit above was restored");

    write("agent/memory/config/domains/payments.ts", "export default { name: 'payments', reach: ['x'] };\n");
    write("agent/memory/config/domains/sundries.ts", "export default { name: 'sundries' };\n");
    eq(computeAppCodeFingerprint(app, "agent"), baseline, "🔴 a per-domain declaration edit (and a new domain) leaves the app fingerprint alone — a domain edit costs no other seat its memory");
    write("agent/access/a2a-agents-test.ts", "export const t = 2;\n");
    eq(computeAppCodeFingerprint(app, "agent"), baseline, "…and so does a test edit");
    write("agent/tools/bash.ts", 'export { default } from "x";\n');
    write("agent/channels/slack.ts", 'export { default } from "y";\n');
    write("agent/lib/providers.generated.ts", "export const SELECTED_PROVIDERS = [];\n");
    write(`agent/${APP_CODE_FINGERPRINT_MODULE}`, renderAppCodeFingerprintModule(baseline));
    eq(computeAppCodeFingerprint(app, "agent"), baseline, "🔴 …and so does the whole of `oe build`'s output, its own module included — a hash of its own output could never settle");

    const custom = makeApp("custom-root", [
      ["roster.config.ts", "export default {};\n"],
      ["bot/agent.ts", "export default {};\n"],
      ["bot/memory/config/domains/a.ts", "export default {};\n"],
    ]);
    eq(appCodeFiles(custom, "bot"), ["bot/agent.ts", "roster.config.ts"], "the app walk follows a custom agent root, with its exclusions re-rooted");
  }

  {
    const app = makeApp("module", APP_FILES);
    const first = writeAppCodeFingerprint(app, "agent");
    eq(first.wrote, true, "control: the first build writes the module");
    eq(first.path, `agent/${APP_CODE_FINGERPRINT_MODULE}`, "…at agent/lib/, beside the provider table that imports it");
    const out = join(app, first.path);
    const text = readFileSync(out, "utf8");
    ok(text.includes(`registerAppCodeFingerprint(${JSON.stringify(first.fingerprint)});`), "🔴 the module REGISTERS the value at import — a module that only exported it would reach no seat");
    ok(text.includes('from "@open-everywhere/core/agent/channels/app-code-fingerprint.js"'), "…through the core package an app installs");
    const stamp = statSync(out).mtimeMs;
    const second = writeAppCodeFingerprint(app, "agent");
    eq(second.wrote, false, "🔴 a rebuild of an unchanged tree writes nothing — `test` and `build` run `oe build` in parallel");
    eq(statSync(out).mtimeMs, stamp, "…and leaves the file's mtime alone");
  }

  {
    const ORG = "org-ope2466";
    const DM = "slack/T1/D0APPCHANGE";
    const SEAT = "oe-dom:e2e-unified:win:discord/111/222:oe-sup:g3-abc123";
    const SURFACE = "discord/111/222";
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains: () => [defineDomain({ name: "e2e-unified", reach: [SURFACE], ambientSupervisor: true })],
      loadSilos: () => [],
      domainsForSurface: () => [],
    });
    const store = getOperationalStore();
    const at = (s: number): string => new Date(Date.UTC(2026, 9, 11, 12, 0, s)).toISOString();
    const app = makeApp("e2e", APP_FILES);
    let deploys = 0;
    const deploy = async (): Promise<{ fingerprint: string; wrote: boolean }> => {
      const built = writeAppCodeFingerprint(app, "agent");
      deploys++;
      await import(`${pathToFileURL(join(app, built.path)).href}?deploy=${deploys}`);
      return built;
    };
    const wake = (s: number) => getOrCreateDmSeat(ORG, { surfaceKey: DM }, at(s));
    const forward = (s: number) => resolveWorkGeneration({ org: ORG, seatToken: SEAT, surfaceKey: SURFACE, atIso: at(s) });

    resetAppCodeFingerprintForTest();
    eq(runningCodeFingerprint(), RUNTIME_CODE_FINGERPRINT, "control: with no app registered the identity is the product half alone");

    const d1 = await deploy();
    eq(runningCodeFingerprint(), `${RUNTIME_CODE_FINGERPRINT}:${d1.fingerprint}`, "🔴 the evaluated module puts the app half INTO the identity a seat compares");
    eq((await wake(1)).generation, 1, "deploy 1: the DM seat mints");
    eq((await store.getChannelSession(ORG, dmWindowRegistryKey(DM)))!.servedCodeFingerprint, runningCodeFingerprint(), "…and its row is stamped with the identity that carries the app half");
    const w1 = await forward(2);
    eq(w1.runtime, "minted", "deploy 1: the work session mints");

    const d2 = await deploy();
    eq(d2.wrote, false, "an identical redeploy rebuilds to the same module bytes");
    eq(d2.fingerprint, d1.fingerprint, "…and the same app fingerprint");
    eq((await wake(3)).generation, 1, "🔴 IDENTICAL REDEPLOY: the DM seat resumes — no seat loses its working memory");
    const w2 = await forward(4);
    eq([w2.runtime, w2.token], ["current", w1.token], "🔴 IDENTICAL REDEPLOY: the work session resumes on the same token");

    writeFileSync(join(app, "agent/memory/config/domains/payments.ts"), "export default { name: 'payments', reach: ['slack/T1/C9'] };\n");
    const d3 = await deploy();
    eq(d3.fingerprint, d1.fingerprint, "🔴 a domain-declaration edit leaves the app half alone");
    eq((await wake(5)).generation, 1, "…so the DM seat resumes");
    eq((await forward(6)).runtime, "current", "…and so does the work session");

    writeFileSync(join(app, "agent/access/a2a-agents.ts"), "export const A2A_AGENTS = [{ name: 'reference' }];\n");
    const d4 = await deploy();
    ok(d4.fingerprint !== d1.fingerprint, "control: the app-only change moved the app half");
    ok(runningCodeFingerprint().startsWith(`${RUNTIME_CODE_FINGERPRINT}:`), "control: …and the product half is unchanged, so only the app half can drive the rotation below");
    const healed = await wake(7);
    eq(healed.generation, 2, "🔴 OPE-2466: an APP-ONLY deploy ROTATES the standing DM seat onto the new bundle");
    const w4 = await forward(8);
    eq(w4.runtime, "rotated", "🔴 OPE-2466: an APP-ONLY deploy ROTATES the work session — the measured test-deployment defect");
    ok(w4.token !== w1.token, "…onto a new work-session token");
    eq((await wake(9)).generation, 2, "NEGATIVE CONTROL: the next wake on the same deploy resumes — the rotation is one-shot");
    eq((await forward(10)).runtime, "current", "NEGATIVE CONTROL: …and so does the next forward");

    assert.throws(() => registerAppCodeFingerprint(""), /16-hex app fingerprint/u);
    n++;
    resetAppCodeFingerprintForTest();
  }

  {
    const providers = readFileSync(join(REPO_ROOT, "agent/lib/providers.generated.ts"), "utf8");
    ok(
      providers.includes('import "./app-code-fingerprint.generated.js";'),
      "🔴 the generated provider table imports the app fingerprint module — without it the value never registers and an app-only deploy rotates nothing",
    );
    for (const register of ["agent/lib/register-adapters.ts", "packages/create/template/agent/lib/register-adapters.ts"]) {
      ok(readFileSync(join(REPO_ROOT, register), "utf8").includes('from "./providers.generated.js"'), `…and ${register} imports the provider table, so the app's boot graph reaches it`);
    }
    const module = readFileSync(join(REPO_ROOT, `agent/${APP_CODE_FINGERPRINT_MODULE}`), "utf8");
    const value = /registerAppCodeFingerprint\("([0-9a-f]{16})"\);/u.exec(module)?.[1];
    ok(value !== undefined, "🔴 `oe build` wrote this tree's app fingerprint module, with a real 16-hex value");
    eq(module, renderAppCodeFingerprintModule(value ?? ""), "…in exactly the shape the writer renders");
    for (const ignore of [".gitignore", "packages/create/template/gitignore"]) {
      ok(readFileSync(join(REPO_ROOT, ignore), "utf8").split("\n").includes("/agent/lib/app-code-fingerprint.generated.ts"), `${ignore} ignores the module — it is build output, and a tracked copy would conflict on every pull request`);
    }
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`✓ app-code-fingerprint: ${n} assertions`);
