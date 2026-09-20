import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { withoutDacOverride, writeBitsBite } from "./dac-fence.js";
import { isVitestCommand, itShardCount, planShards, tierProofLine, worstExit } from "./it-shards.js";
import { fmtBytes, samplePeakRss } from "./proc-rss.js";

const DEFAULT_LOCK_DIR = "/tmp/oe-suite-locks/full-suite.lock";
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;
export const DEFAULT_POLL_MS = 5_000;
export const DEFAULT_NOTICE_INTERVAL_MS = 60_000;

export interface LockHolder {
  readonly pid: number;
  readonly startedAt: string;
  readonly command: string;
}

export interface AcquireOptions {
  readonly pollMs?: number;
  readonly noticeIntervalMs?: number;
  readonly command?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function holderPath(lockDir: string): string {
  return join(lockDir, "holder.json");
}

export function readHolder(lockDir: string): LockHolder | undefined {
  let raw: string;
  try {
    raw = readFileSync(holderPath(lockDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "an unknown time",
      command: typeof parsed.command === "string" ? parsed.command : "an unknown command",
    };
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function writeHolder(lockDir: string, command: string): void {
  const holder: LockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: command.length > 200 ? `${command.slice(0, 197)}...` : command,
  };
  try {
    writeFileSync(holderPath(lockDir), `${JSON.stringify(holder, null, 2)}\n`);
  } catch {
  }
}

function describeAge(holder: LockHolder): string {
  const started = Date.parse(holder.startedAt);
  if (Number.isNaN(started)) return `since ${holder.startedAt}`;
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60_000));
  return `since ${holder.startedAt} (${minutes}m ago)`;
}

export type ReclaimResult = "reclaimed" | "not-stale" | "failed";

export function reclaimDeadLock(lockDir: string, deadHolder: LockHolder): ReclaimResult {
  const staging = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockDir, staging);
  } catch (err) {
    console.error(
      `suite-lock-run: could NOT reclaim ${lockDir} from dead holder pid ${deadHolder.pid} ` +
        `(${(err as NodeJS.ErrnoException).code ?? "unknown error"}) — another acquirer may have taken it first, or this ` +
        `user cannot write ${dirname(lockDir)}. Falling back to waiting; remove the directory by hand to unblock.`,
    );
    return "failed";
  }
  const carried = readHolder(staging);
  if (carried?.pid !== deadHolder.pid) {
    try {
      renameSync(staging, lockDir);
    } catch {
      rmSync(staging, { recursive: true, force: true });
    }
    return "not-stale";
  }
  console.error(
    `suite-lock-run: reclaimed ${lockDir} — its holder pid ${deadHolder.pid} (${describeAge(deadHolder)}) is no longer running, ` +
      `so the lock was left behind by a killed run. Proceeding.`,
  );
  rmSync(staging, { recursive: true, force: true });
  return "reclaimed";
}

export async function acquireLock(lockDir: string, maxWaitMs: number, options: AcquireOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const noticeIntervalMs = options.noticeIntervalMs ?? DEFAULT_NOTICE_INTERVAL_MS;
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + maxWaitMs;
  let lastNoticeAt = 0;
  const reclaimAttempted = new Set<number>();
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeHolder(lockDir, options.command ?? "an unnamed command");
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    const holder = readHolder(lockDir);
    const holderIsDead = holder !== undefined && !pidAlive(holder.pid);
    if (holder && holderIsDead && !reclaimAttempted.has(holder.pid)) {
      reclaimAttempted.add(holder.pid);
      if (reclaimDeadLock(lockDir, holder) !== "failed") {
        continue;
      }
    }

    const now = Date.now();
    const deadNote = holderIsDead ? ", whose pid is NOT running (a reclaim was attempted and failed)" : "";
    if (now - lastNoticeAt >= noticeIntervalMs) {
      console.error(
        holder
          ? `suite-lock-run: ${lockDir} is held by pid ${holder.pid}${deadNote} ${describeAge(holder)} — waiting ` +
            `(this box runs one full suite at a time). Holder command: ${holder.command}`
          : `suite-lock-run: ${lockDir} is held, and carries no holder.json — its liveness cannot be checked, ` +
            `so this run waits out its ${maxWaitMs}ms ceiling (\`ls -la ${lockDir}\` / \`ps aux\` to find the holder).`,
      );
      lastNoticeAt = now;
    }
    if (now > deadline) {
      const who = holder ? `pid ${holder.pid}${deadNote} ${describeAge(holder)}` : "an unrecorded holder";
      throw new Error(
        `suite-lock-run: timed out after ${maxWaitMs}ms waiting for ${lockDir}, held by ${who} — ` +
          `check \`ls -la ${lockDir}\` / \`ps aux\` for the holder.`,
      );
    }
    await sleep(pollMs);
  }
}

export function releaseLock(lockDir: string): void {
  const holder = readHolder(lockDir);
  if (holder && holder.pid !== process.pid) {
    console.error(`suite-lock-run: not releasing ${lockDir} — it is now held by pid ${holder.pid}, not this process.`);
    return;
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
  }
}

export const SIGKILL_EXIT_CODE = 137;

export function classifyExit(code: number | null, signal: NodeJS.Signals | null, command: string): number {
  if (signal === "SIGKILL" || code === SIGKILL_EXIT_CODE) {
    console.error(
      `suite-lock-run: 🔴 KILLED (SIGKILL / exit ${SIGKILL_EXIT_CODE}) — \`${command}\` produced no verdict of its own. ` +
        "On a memory-capped box this is the kernel's OOM killer, not a product failure: the integration tier boots one " +
        "agent host per worker, and two hosts peak above a cloud sandbox's memory cgroup (OPE-1369). Do NOT hunt the " +
        "last test that printed — it is simply the file that was running. Re-run at OE_IT_CI_MAX_WORKERS=1 and raise " +
        "OE_IT_SHARDS so fewer files share one process (this wrapper shards by default in a sandbox — OPE-1814), and " +
        "confirm with `dmesg | grep -i oom`.",
    );
    return SIGKILL_EXIT_CODE;
  }
  return code ?? (signal ? 1 : 0);
}

function spawnMeasured(cmd: string, args: readonly string[], label: string): Promise<{ exit: number; peakRssBytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: "inherit", shell: process.platform === "win32" });
    const sampler = child.pid === undefined ? undefined : samplePeakRss(child.pid);
    child.on("error", (err) => {
      sampler?.stop();
      reject(err);
    });
    child.on("exit", (code, signal) => {
      const peakRssBytes = sampler?.stop() ?? 0;
      resolve({ exit: classifyExit(code, signal, label), peakRssBytes });
    });
  });
}

function headSha(): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
    return /^[0-9a-f]{7,40}$/u.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

export function fencedSpawn(cmd: string, args: readonly string[]): { cmd: string; args: string[] } {
  if (!isVitestCommand(cmd) || writeBitsBite()) return { cmd, args: [...args] };
  console.error(
    "suite-lock-run: this process BYPASSES the POSIX write bits (uid 0 with CAP_DAC_OVERRIDE), which would invert every " +
      "write-fence assertion in the tier. Spawning the suite with the DAC bypass dropped (OPE-1989/OPE-1990) — same uid, " +
      "same file ownership, ordinary permission checks.",
  );
  return withoutDacOverride(cmd, args);
}

export async function runLocked(
  cmd: string,
  args: string[],
  options: { manual: boolean; lockDir: string; maxWaitMs: number; env?: NodeJS.ProcessEnv; emitProof?: boolean },
): Promise<number> {
  const plan = planShards(cmd, args, itShardCount(options.env ?? process.env));
  let acquired = false;
  if (!options.manual) {
    await acquireLock(options.lockDir, options.maxWaitMs, { command: [cmd, ...args].join(" ") });
    acquired = true;
  }
  try {
    if (plan.runs.length > 1) {
      console.error(
        `suite-lock-run: sharding the integration tier into ${plan.runs.length} sequential one-process passes (OE_IT_SHARDS). ` +
          "A single process runs the whole tier past a cloud sandbox's memory cgroup even at one worker (OPE-1814).",
      );
    } else if (plan.reason !== undefined) {
      console.error(`suite-lock-run: not sharding — ${plan.reason}.`);
    }
    const exits: number[] = [];
    for (const run of plan.runs) {
      const label = [cmd, ...run.args].join(" ");
      const spawnPair = fencedSpawn(cmd, run.args);
      const { exit, peakRssBytes } = await spawnMeasured(spawnPair.cmd, spawnPair.args, label);
      exits.push(exit);
      console.error(`suite-lock-run: ${plan.wholeTier ? run.suite : label} exit=${exit} peak-tree-rss=${fmtBytes(peakRssBytes)}`);
    }
    const exit = worstExit(exits);
    if (options.emitProof === true && plan.wholeTier) {
      const sha = headSha();
      if (sha === undefined) {
        console.error("suite-lock-run: no OE_PROOF line — `git rev-parse HEAD` answered nothing usable, and a line with no sha proves nothing.");
      } else {
        console.log(tierProofLine(sha, exit));
      }
    }
    return exit;
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

  const exitCode = await runLocked(cmd, rest, { manual, lockDir, maxWaitMs, emitProof: true });
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
