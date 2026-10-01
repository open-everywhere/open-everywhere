import { preflight, type Check, type PreflightOptions } from "./quickstart.js";

export type PreflightProbe = (env: NodeJS.ProcessEnv) => Promise<readonly Check[]>;

const PROBES: Record<string, PreflightProbe> = {};

export function registerPreflightProbe(name: string, probe: PreflightProbe): void {
  PROBES[name] = probe;
}

export function _resetPreflightProbesForTest(): void {
  for (const k of Object.keys(PROBES)) delete PROBES[k];
}

export async function runPreflightProbes(env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const names = Object.keys(PROBES).sort();
  const settled = await Promise.all(
    names.map(async (name): Promise<readonly Check[]> => {
      try {
        return await PROBES[name](env);
      } catch (err) {
        return [
          {
            name: `${name}: live probe`,
            status: "info" as const,
            detail: `could not run — ${err instanceof Error ? err.message : String(err)}`,
          },
        ];
      }
    }),
  );
  return settled.flat();
}

export async function preflightAsync(
  env: NodeJS.ProcessEnv = process.env,
  options: PreflightOptions = {},
): Promise<{ checks: Check[]; ready: boolean }> {
  const base = preflight(env, options);
  const probed = await runPreflightProbes(env);
  const checks = [...base.checks, ...probed];
  return { checks, ready: checks.every((c) => c.status !== "missing") };
}
