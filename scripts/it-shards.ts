import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { cgroupMemoryCapBytes, type BoxProbe, HOST_BOX_PROBE } from "./ci-max-workers.js";

export const SANDBOX_MIN_SHARDS = 4;
export const SANDBOX_FILES_PER_SHARD = 32;
export const LOCAL_SHARDS = 1;

export const INTEGRATION_INCLUDE_GLOBS: readonly string[] = ["tests/integration/**/*.test.ts"];

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface TierFileProbe {
  readonly readDir: (path: string) => readonly DirEntry[];
}

export const HOST_TIER_FILE_PROBE: TierFileProbe = {
  readDir: (path) => readdirSync(path, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
};

const TIER_GLOB_RE = /^([^*?[\]]+)\/\*\*\/\*(\.[^*?[\]/]+)$/u;

function collectFiles(probe: TierFileProbe, root: string, rel: string, suffix: string, seen: Set<string>): boolean {
  let entries: readonly DirEntry[];
  try {
    entries = probe.readDir(join(root, rel));
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = join(rel, entry.name);
    if (entry.isDirectory) {
      if (!collectFiles(probe, root, child, suffix, seen)) return false;
    } else if (entry.name.endsWith(suffix)) {
      seen.add(child);
    }
  }
  return true;
}

export function listTierFiles(
  root: string = process.cwd(),
  globs: readonly string[] = INTEGRATION_INCLUDE_GLOBS,
  probe: TierFileProbe = HOST_TIER_FILE_PROBE,
): string[] | undefined {
  const seen = new Set<string>();
  for (const glob of globs) {
    const match = TIER_GLOB_RE.exec(glob);
    if (match === null) return undefined;
    if (!collectFiles(probe, root, match[1]!, match[2]!, seen)) return undefined;
  }
  return [...seen].map((file) => file.split("\\").join("/")).sort();
}

export function countTierFiles(
  root: string = process.cwd(),
  globs: readonly string[] = INTEGRATION_INCLUDE_GLOBS,
  probe: TierFileProbe = HOST_TIER_FILE_PROBE,
): number | undefined {
  return listTierFiles(root, globs, probe)?.length;
}

export function sandboxShardCount(files: number | undefined): number {
  if (files === undefined || files <= 0) return SANDBOX_MIN_SHARDS;
  return Math.max(SANDBOX_MIN_SHARDS, Math.ceil(files / SANDBOX_FILES_PER_SHARD));
}

export const INTEGRATION_SUITE_NAME = "test:integration";

export function itShardsOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OE_IT_SHARDS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export const SINGLE_SHARD_ENV = "OE_IT_SHARD";

export interface ShardSelector {
  readonly index: number;
  readonly total: number;
}

export type ShardSelectorRead =
  | { readonly kind: "none" }
  | { readonly kind: "shard"; readonly selector: ShardSelector }
  | { readonly kind: "invalid"; readonly reason: string };

export function itShardSelector(env: NodeJS.ProcessEnv = process.env): ShardSelectorRead {
  const raw = env[SINGLE_SHARD_ENV];
  if (raw === undefined || raw.trim() === "") return { kind: "none" };
  const match = /^(\d+)\/(\d+)$/u.exec(raw.trim());
  if (match === null) return { kind: "invalid", reason: `${SINGLE_SHARD_ENV}=${raw} is not of the form k/N` };
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) {
    return { kind: "invalid", reason: `${SINGLE_SHARD_ENV}=${raw} needs 1 <= k <= N` };
  }
  const override = itShardsOverride(env);
  if (override !== undefined && override !== total) {
    return { kind: "invalid", reason: `${SINGLE_SHARD_ENV}=${raw} names N=${total}, but OE_IT_SHARDS=${override} names another split` };
  }
  return { kind: "shard", selector: { index, total } };
}

export function itShardCount(
  env: NodeJS.ProcessEnv = process.env,
  probe: BoxProbe = HOST_BOX_PROBE,
  countFiles: () => number | undefined = () => countTierFiles(),
): number {
  const override = itShardsOverride(env);
  if (override !== undefined) return override;
  const ci = (env.CI ?? "").trim();
  const declaredCi = ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
  if (declaredCi) return sandboxShardCount(countFiles());
  return cgroupMemoryCapBytes(probe) === undefined ? LOCAL_SHARDS : sandboxShardCount(countFiles());
}

const FILTER_FLAG_RE = /^--?(t|testNamePattern|dir|project|projects|related|changed|exclude|testPathPattern)(=|$)/u;

export interface ShardRun {
  readonly args: readonly string[];
  readonly suite: string;
}

export interface ShardPlan {
  readonly wholeTier: boolean;
  readonly proofSuite: string;
  readonly reason?: string;
  readonly runs: readonly ShardRun[];
}

export function isVitestCommand(cmd: string): boolean {
  return /(^|[\\/])vitest(\.cmd|\.js)?$/u.test(cmd);
}

export function planShards(cmd: string, args: readonly string[], shards: number, only?: ShardSelector): ShardPlan {
  const single: ShardRun[] = [{ args: [...args], suite: INTEGRATION_SUITE_NAME }];
  const unsharded = (reason: string): ShardPlan => ({
    wholeTier: false,
    proofSuite: INTEGRATION_SUITE_NAME,
    reason,
    runs: [{ args: [...args], suite: INTEGRATION_SUITE_NAME }],
  });

  if (!isVitestCommand(cmd)) return unsharded(`the wrapped command is \`${cmd}\`, not vitest`);
  if (args[0] !== "run") return unsharded("the wrapped vitest call is not `vitest run`");
  const rest = args.slice(1);
  if (rest.some((a) => a.startsWith("--shard"))) return unsharded("the caller already chose a --shard");
  if (rest.some((a) => FILTER_FLAG_RE.test(a))) return unsharded("the call carries a filter flag, so it is a targeted leg and not the tier");
  if (rest.some((a) => !a.startsWith("-"))) return unsharded("the call carries a file filter, so it is a targeted leg and not the tier");

  if (only !== undefined) {
    const run = shardRun(args, only.index, only.total);
    return { wholeTier: true, proofSuite: run.suite, runs: [run] };
  }
  if (shards <= 1) return { wholeTier: true, proofSuite: INTEGRATION_SUITE_NAME, runs: single };
  const runs: ShardRun[] = [];
  for (let k = 1; k <= shards; k++) runs.push(shardRun(args, k, shards));
  return { wholeTier: true, proofSuite: INTEGRATION_SUITE_NAME, runs };
}

function shardRun(args: readonly string[], index: number, total: number): ShardRun {
  return { args: [...args, `--shard=${index}/${total}`], suite: `${INTEGRATION_SUITE_NAME}--shard=${index}/${total}` };
}

export const TIER_TIMINGS_PATH = "scripts/it-timings.json";

export type TierTimings = ReadonlyMap<string, number>;

export function readTierTimings(root: string = process.cwd(), path: string = TIER_TIMINGS_PATH): TierTimings {
  let raw: string;
  try {
    raw = readFileSync(join(root, path), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  return parseTierTimings(raw, path);
}

export function parseTierTimings(raw: string, label: string = TIER_TIMINGS_PATH): TierTimings {
  const doc = JSON.parse(raw) as { files?: unknown };
  if (typeof doc !== "object" || doc === null || typeof doc.files !== "object" || doc.files === null || Array.isArray(doc.files)) {
    throw new Error(`${label}: expected an object with a "files" object of path → milliseconds`);
  }
  const timings = new Map<string, number>();
  for (const [file, ms] of Object.entries(doc.files as Record<string, unknown>)) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      throw new Error(`${label}: ${file} has ${JSON.stringify(ms)}, not a non-negative number of milliseconds`);
    }
    timings.set(file, ms);
  }
  return timings;
}

export function shardWeights(files: readonly string[], timings: TierTimings): Map<string, number> {
  const measured = files
    .map((file) => timings.get(file))
    .filter((ms): ms is number => ms !== undefined)
    .sort((a, b) => a - b);
  const mid = Math.floor(measured.length / 2);
  const median = measured.length === 0 ? 1 : measured.length % 2 === 1 ? measured[mid]! : (measured[mid - 1]! + measured[mid]!) / 2;
  return new Map(files.map((file) => [file, timings.get(file) ?? median]));
}

export function balanceShards(files: readonly string[], total: number, timings: TierTimings): string[][] {
  const weights = shardWeights(files, timings);
  const order = [...new Set(files)].sort((a, b) => {
    const diff = weights.get(b)! - weights.get(a)!;
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }));
  const cap = Math.max(SANDBOX_FILES_PER_SHARD, Math.ceil(order.length / Math.max(total, 1)));
  for (const file of order) {
    let best: (typeof shards)[number] | undefined;
    for (const shard of shards) {
      if (shard.files.length >= cap) continue;
      if (best === undefined || shard.load < best.load || (shard.load === best.load && shard.files.length < best.files.length)) best = shard;
    }
    if (best === undefined) best = shards[0]!;
    best.files.push(file);
    best.load += Math.max(weights.get(file)!, Number.EPSILON);
  }
  return shards.map((shard) => shard.files.sort());
}

export function shardFiles(files: readonly string[], index: number, total: number, timings: TierTimings): string[] {
  return balanceShards(files, total, timings)[index - 1] ?? [];
}

export function tierFilesDigest(files: readonly string[]): string {
  return createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 12);
}

export function worstExit(codes: readonly number[]): number {
  return codes.reduce((worst, code) => (code > worst ? code : worst), 0);
}

export function tierProofLine(sha: string, exit: number, suite: string = INTEGRATION_SUITE_NAME): string {
  return `OE_PROOF sha=${sha} suite=${suite} exit=${exit}`;
}

