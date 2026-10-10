import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { testValveArmed, __setTestValveForTest, type TestValve } from "../agent/testing/test-valves.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const VALVES: readonly TestValve[] = ["egress-spoof", "scripted-model", "memory-eval"];

for (const v of VALVES) {
  ok(!testValveArmed(v), `1a. ${v} ships unarmed`);
  __setTestValveForTest(v, true);
  ok(testValveArmed(v), `1b. ${v} arms`);
  __setTestValveForTest(v, false);
  ok(!testValveArmed(v), `1c. ${v} disarms`);
}

{
  const RETIRED: Record<TestValve, string> = {
    "egress-spoof": "OE_EGRESS_SPOOF",
    "scripted-model": "OE_SCRIPTED_MODEL",
    "memory-eval": "OE_MEMORY_EVAL",
  };
  for (const v of VALVES) {
    const name = RETIRED[v];
    const prior = process.env[name];
    process.env[name] = "1";
    ok(!testValveArmed(v), `2. the retired ${name}=1 env var does not arm ${v}`);
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

{
  const key = Symbol.for("open-everywhere.test-valves.v1");
  const store = (globalThis as { [k: symbol]: unknown })[key];
  ok(store instanceof Map, "3a. the store lives on globalThis under the preload's key");
  (store as Map<string, boolean>).set("memory-eval", true);
  ok(testValveArmed("memory-eval"), "3b. a write through the preload's raw key reads as armed");
  __setTestValveForTest("memory-eval", false);
  for (const [file, valve] of [["arm-memory-eval.mjs", "memory-eval"], ["arm-egress-spoof.mjs", "egress-spoof"]] as const) {
    const preload = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "eval", file), "utf8");
    ok(preload.includes('Symbol.for("open-everywhere.test-valves.v1")'), `3c. ${file} spells the same key`);
    ok(preload.includes(`valves.set("${valve}", true)`), `3d. …and arms the ${valve} valve by its exact name`);
  }
}

{
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "scripts") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") && !full.endsWith("test-valves.ts") && readFileSync(full, "utf8").includes("__setTestValveForTest(")) {
        offenders.push(relative(repoRoot, full));
      }
    }
  };
  for (const root of ["agent", "packages/core/agent", "packages/adapters/agent", "packages/providers"]) walk(join(repoRoot, root));
  ok(offenders.length === 0, `4. no shipped agent code arms a test valve — offenders: ${offenders.join(", ") || "(none)"}`);
}

console.log(`✓ test-valves (OPE-2411) — ${n} assertions (unarmed by default; the retired env vars arm nothing; the preload key matches; no product code arms a valve)`);
