import { readFileSync } from "node:fs";
import { estimateStackCostUsd, type RoleTokenUsage, type TokenProfile } from "@open-everywhere/core/agent/spend/stack-pricing.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
const { STACKS, STACK_ALIASES } = await importAppModule<typeof import("../agent/model/stacks.js")>("agent/model/stacks.ts", APP_ROOT);

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const ILLUSTRATIVE_PROFILE: TokenProfile = {
  primary: { inputTokens: 20_000_000, outputTokens: 3_000_000 },
  utility: { inputTokens: 3_000_000, outputTokens: 500_000 },
  vision: { inputTokens: 200_000, outputTokens: 20_000 },
  supervisor: { inputTokens: 8_000_000, outputTokens: 1_000_000 },
  judge: { inputTokens: 500_000, outputTokens: 100_000 },
};

function loadProfile(path: string | undefined): { profile: TokenProfile; label: string } {
  if (!path) return { profile: ILLUSTRATIVE_PROFILE, label: "ILLUSTRATIVE (shaped, not measured — see script header)" };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`--profile ${path}: expected a JSON object of { role: { inputTokens, outputTokens } }`);
  }
  const out: Record<string, RoleTokenUsage> = {};
  for (const [role, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const { inputTokens, outputTokens } = v as Record<string, unknown>;
    if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
      throw new Error(`--profile ${path}: role "${role}" needs numeric inputTokens/outputTokens`);
    }
    out[role] = { inputTokens, outputTokens };
  }
  return { profile: out, label: path };
}

function usd(n: number): string {
  return `$${n.toFixed(n < 10 ? 4 : 2)}`;
}

function band(minUsd: number, maxUsd: number, unpriced: boolean): string {
  if (unpriced) return "UNPRICED (no measured rate for this model)";
  return minUsd === maxUsd ? usd(minUsd) : `${usd(minUsd)} - ${usd(maxUsd)}`;
}

function main(): void {
  const { profile, label } = loadProfile(flag("profile"));

  console.log(`Open Everywhere — per-stack pricing estimate\n`);
  console.log(`Profile: ${label}\n`);

  for (const alias of STACK_ALIASES) {
    const stack = STACKS[alias];
    const estimate = estimateStackCostUsd(stack, profile);
    console.log(`── ${alias} `.padEnd(72, "─"));
    for (const r of estimate.roles) {
      console.log(`  ${r.role.padEnd(10)} ${r.modelId.padEnd(34)} ${band(r.minUsd, r.maxUsd, r.unpriced)}`);
    }
    const totalLabel = estimate.partial ? "TOTAL (partial — one or more roles unpriced)" : "TOTAL";
    console.log(`  ${totalLabel.padEnd(45)} ${band(estimate.totalMinUsd, estimate.totalMaxUsd, false)}`);
    console.log("");
  }

  console.log("Caveats (always true of every estimate above):");
  console.log("  1. Cache savings are EXCLUDED — every input token is priced at the full rate,");
  console.log("     so each band is a conservative UPPER BOUND, never a best case.");
  console.log("  2. Open-weights bands (deepseek) are LOAD-BALANCER-DEPENDENT — the gateway");
  console.log("     spreads that id across upstreams billing different rates; the true cost for");
  console.log("     any given period lands somewhere inside the band, not at a fixed point.");
}

main();
