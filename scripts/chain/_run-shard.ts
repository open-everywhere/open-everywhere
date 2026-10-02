import { test, vi } from "vitest";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chainLegs, legLabel, legsForShard, needsSubprocess, SUBPROCESS_LEG_TIMEOUT_MS, type ChainLeg } from "./_legs.js";
import { resetProcessGlobals } from "./_process-state.js";

const execFileAsync = promisify(execFile);

class SuiteCalledProcessExit extends Error {
  readonly code: number | string | null | undefined;
  constructor(code: number | string | null | undefined) {
    super(`the suite called process.exit(${String(code)}) — under the batched runner that is a failure signal`);
    this.name = "SuiteCalledProcessExit";
    this.code = code;
  }
}

function isSuccessExit(code: number | string | null | undefined): boolean {
  return code === undefined || code === null || code === 0 || code === "0";
}

async function runLegInSubprocess(leg: ChainLeg): Promise<void> {
  try {
    await execFileAsync("npm", ["run", leg.script], { cwd: leg.dir, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new Error(`\`npm run ${leg.script}\` failed in its own process:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}

export async function runLegInProcess(leg: ChainLeg): Promise<void> {
  const envBefore = { ...process.env };
  const cwdBefore = process.cwd();
  const exitBefore = process.exit;
  const exitCodeBefore = process.exitCode;
  const argvBefore = process.argv;
  process.exitCode = undefined;
  (process as { exit: unknown }).exit = (code?: number | string | null) => {
    throw new SuiteCalledProcessExit(code);
  };
  vi.resetModules();
  resetProcessGlobals();
  process.chdir(leg.dir);
  process.argv = [process.execPath, leg.file, ...(leg.args ?? [])];
  try {
    try {
      await import(pathToFileURL(leg.file).href);
    } catch (error) {
      if (!(error instanceof SuiteCalledProcessExit) || !isSuccessExit(error.code)) throw error;
    }
    if (process.exitCode !== undefined && process.exitCode !== 0) {
      throw new Error(`the suite set process.exitCode=${String(process.exitCode)} — it failed without throwing`);
    }
  } finally {
    process.chdir(cwdBefore);
    (process as { exit: unknown }).exit = exitBefore;
    process.exitCode = exitCodeBefore;
    process.argv = argvBefore;
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
  }
}

export function runShard(index: number): void {
  for (const leg of legsForShard(index, chainLegs())) {
    const inSubprocess = needsSubprocess(leg);
    test(
      legLabel(leg),
      () => (inSubprocess ? runLegInSubprocess(leg) : runLegInProcess(leg)),
      inSubprocess ? SUBPROCESS_LEG_TIMEOUT_MS : undefined,
    );
  }
}
