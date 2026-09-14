import { cgroupMemoryCapBytes, type MemoryProbe, HOST_MEMORY_PROBE } from "./ci-max-workers.js";

export const SANDBOX_SHARDS = 4;
export const LOCAL_SHARDS = 1;

export const INTEGRATION_SUITE_NAME = "test:integration";

export function itShardsOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OE_IT_SHARDS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export function itShardCount(env: NodeJS.ProcessEnv = process.env, probe: MemoryProbe = HOST_MEMORY_PROBE): number {
  const override = itShardsOverride(env);
  if (override !== undefined) return override;
  const ci = (env.CI ?? "").trim();
  const declaredCi = ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
  if (declaredCi) return SANDBOX_SHARDS;
  return cgroupMemoryCapBytes(probe) === undefined ? LOCAL_SHARDS : SANDBOX_SHARDS;
}

const FILTER_FLAG_RE = /^--?(t|testNamePattern|dir|project|projects|related|changed|exclude|testPathPattern)(=|$)/u;

export interface ShardRun {
  readonly args: readonly string[];
  readonly suite: string;
}

export interface ShardPlan {
  readonly wholeTier: boolean;
  readonly reason?: string;
  readonly runs: readonly ShardRun[];
}

export function planShards(cmd: string, args: readonly string[], shards: number): ShardPlan {
  const single: ShardRun[] = [{ args: [...args], suite: INTEGRATION_SUITE_NAME }];
  const unsharded = (reason: string): ShardPlan => ({ wholeTier: false, reason, runs: [{ args: [...args], suite: INTEGRATION_SUITE_NAME }] });

  if (!/(^|[\\/])vitest(\.cmd|\.js)?$/u.test(cmd)) return unsharded(`the wrapped command is \`${cmd}\`, not vitest`);
  if (args[0] !== "run") return unsharded("the wrapped vitest call is not `vitest run`");
  const rest = args.slice(1);
  if (rest.some((a) => a.startsWith("--shard"))) return unsharded("the caller already chose a --shard");
  if (rest.some((a) => FILTER_FLAG_RE.test(a))) return unsharded("the call carries a filter flag, so it is a targeted leg and not the tier");
  if (rest.some((a) => !a.startsWith("-"))) return unsharded("the call carries a file filter, so it is a targeted leg and not the tier");

  if (shards <= 1) return { wholeTier: true, runs: single };
  const runs: ShardRun[] = [];
  for (let k = 1; k <= shards; k++) {
    runs.push({ args: [...args, `--shard=${k}/${shards}`], suite: `${INTEGRATION_SUITE_NAME}--shard=${k}/${shards}` });
  }
  return { wholeTier: true, runs };
}

export function worstExit(codes: readonly number[]): number {
  return codes.reduce((worst, code) => (code > worst ? code : worst), 0);
}

export function tierProofLine(sha: string, exit: number): string {
  return `OE_PROOF sha=${sha} suite=${INTEGRATION_SUITE_NAME} exit=${exit}`;
}
