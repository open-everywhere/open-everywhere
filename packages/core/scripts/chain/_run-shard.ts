import { test, vi } from "vitest";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { CORE_ROOT, SUBPROCESS_LEGS, chainLegs, legsForShard, type ChainLeg } from "./_legs.js";
import { resetProcessGlobals } from "./_process-state.js";

const execFileAsync = promisify(execFile);

class SuiteCalledProcessExit extends Error {
  constructor(code: number | string | null | undefined) {
    super(`the suite called process.exit(${String(code)}) — under the batched runner that is a failure signal`);
    this.name = "SuiteCalledProcessExit";
  }
}

async function runLegInSubprocess(leg: ChainLeg): Promise<void> {
  try {
    await execFileAsync("npm", ["run", leg.script], { cwd: CORE_ROOT, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new Error(`\`npm run ${leg.script}\` failed in its own process:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}

async function runLegInProcess(leg: ChainLeg): Promise<void> {
  const envBefore = { ...process.env };
  const exitBefore = process.exit;
  const exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  (process as { exit: unknown }).exit = (code?: number | string | null) => {
    throw new SuiteCalledProcessExit(code);
  };
  vi.resetModules();
  resetProcessGlobals();
  try {
    await import(pathToFileURL(join(CORE_ROOT, leg.file)).href);
    if (process.exitCode !== undefined && process.exitCode !== 0) {
      throw new Error(`the suite set process.exitCode=${String(process.exitCode)} — it failed without throwing`);
    }
  } finally {
    (process as { exit: unknown }).exit = exitBefore;
    process.exitCode = exitCodeBefore;
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
  }
}

export function runShard(index: number): void {
  for (const leg of legsForShard(index, chainLegs())) {
    test(leg.script, () => (SUBPROCESS_LEGS.has(leg.script) ? runLegInSubprocess(leg) : runLegInProcess(leg)));
  }
}
