import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LOCK_DIR = "/tmp/oe-suite-locks/full-suite.lock";
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;
const POLL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireLock(lockDir: string, maxWaitMs: number): Promise<void> {
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + maxWaitMs;
  let warned = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (!warned) {
        console.error(`suite-lock-run: ${lockDir} is held — waiting (this box runs one full suite at a time; \`ls ${dirname(lockDir)}\` to see who holds it).`);
        warned = true;
      }
      if (Date.now() > deadline) {
        throw new Error(`suite-lock-run: timed out after ${maxWaitMs}ms waiting for ${lockDir} to free — check \`ls ${dirname(lockDir)}\` / \`ps aux\` for the holder.`);
      }
      await sleep(POLL_MS);
    }
  }
}

export function releaseLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
  }
}

export async function runLocked(
  cmd: string,
  args: string[],
  options: { manual: boolean; lockDir: string; maxWaitMs: number },
): Promise<number> {
  let acquired = false;
  if (!options.manual) {
    await acquireLock(options.lockDir, options.maxWaitMs);
    acquired = true;
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    if (acquired) releaseLock(options.lockDir);
  }
}

async function main(): Promise<void> {
  const sepIndex = process.argv.indexOf("--");
  const cmdArgs = sepIndex >= 0 ? process.argv.slice(sepIndex + 1) : process.argv.slice(2);
  if (cmdArgs.length === 0) {
    console.error("suite-lock-run: usage: tsx scripts/suite-lock-run.ts -- <command> [args...]");
    process.exit(2);
  }
  const [cmd, ...rest] = cmdArgs;
  const manual = process.env.OE_SUITE_LOCK_MANUAL === "1";
  const lockDir = process.env.OE_SUITE_LOCK_DIR ?? DEFAULT_LOCK_DIR;
  const maxWaitMs = process.env.OE_SUITE_LOCK_MAX_WAIT_MS ? Number(process.env.OE_SUITE_LOCK_MAX_WAIT_MS) : DEFAULT_MAX_WAIT_MS;

  const exitCode = await runLocked(cmd, rest, { manual, lockDir, maxWaitMs });
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
