import type { ModelReasoning, ModelRoute, ModelTier, Domain, NamedKnobLayer } from "../memory/domain.js";

export interface ModelPolicyAllowEntry {
  readonly id: string;
  readonly tier: ModelTier;
}

export interface ModelPolicy {
  readonly allow?: readonly ModelPolicyAllowEntry[];
  readonly reasoningCeiling?: ModelReasoning;
  readonly providerDeny?: readonly string[];
}

export function defineModelPolicy(policy: ModelPolicy): ModelPolicy {
  return policy;
}

export const REASONING_ORDER: readonly ModelReasoning[] = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function reasoningRank(level: ModelReasoning): number {
  return REASONING_ORDER.indexOf(level);
}

export function clampReasoning(requested: ModelReasoning | undefined, ceiling: ModelReasoning): ModelReasoning | undefined {
  if (requested === undefined) return undefined;
  const r = reasoningRank(requested);
  const c = reasoningRank(ceiling);
  if (r === -1 || r > c) return ceiling;
  return requested;
}

export function modelProviderOf(id: string): string {
  const i = id.indexOf("/");
  return i === -1 ? id : id.slice(0, i);
}

export function isProviderDenied(id: string, policy: ModelPolicy | undefined): boolean {
  if (!policy?.providerDeny?.length) return false;
  return policy.providerDeny.includes(modelProviderOf(id));
}

export function isModelUsable(id: string, policy: ModelPolicy | undefined): boolean {
  if (!policy) return true;
  if (isProviderDenied(id, policy)) return false;
  if (!policy.allow?.length) return true;
  return policy.allow.some((a) => a.id === id);
}

export function pickTierModel(tier: ModelTier, policy: ModelPolicy): string | undefined {
  const entry = policy.allow?.find((a) => a.tier === tier && !isProviderDenied(a.id, policy));
  return entry?.id;
}

const TIER_FALLBACK_ORDER: readonly ModelTier[] = ["low", "medium", "high"];

export function safeFallbackModel(policy: ModelPolicy | undefined, defaultId: string): string {
  if (policy?.allow?.length) {
    for (const tier of TIER_FALLBACK_ORDER) {
      const id = pickTierModel(tier, policy);
      if (id) return id;
    }
  }
  return defaultId;
}

export interface EnvelopeResult {
  readonly id?: string;
  readonly reasoning?: ModelReasoning;
  readonly warnings: readonly string[];
}

export function applyModelPolicyToRoute(
  route: ModelRoute,
  policy: ModelPolicy | undefined,
  defaultId: string,
  effectiveCeiling?: ModelReasoning,
): EnvelopeResult {
  if (!policy) return { id: route.id, reasoning: route.reasoning, warnings: [] };

  const warnings: string[] = [];
  let id = route.id;
  const requestedSomething = route.id !== undefined || route.tier !== undefined;

  if (requestedSomething) {
    if (id === undefined && route.tier !== undefined) {
      const picked = pickTierModel(route.tier, policy);
      if (picked !== undefined) id = picked;
      else warnings.push(`tier "${route.tier}" has no usable allow-listed model`);
    }
    if (id !== undefined && !isModelUsable(id, policy)) {
      warnings.push(`model "${id}" is not allowed by the org model policy`);
      id = undefined;
    }
    if (id === undefined) {
      id = safeFallbackModel(policy, defaultId);
    }
  }

  const ceiling = effectiveCeiling ?? policy.reasoningCeiling ?? "medium";
  const reasoning = clampReasoning(route.reasoning, ceiling);
  if (route.reasoning !== undefined && reasoning !== route.reasoning) {
    warnings.push(`reasoning "${route.reasoning}" exceeds the org ceiling "${ceiling}" — clamped to "${reasoning}"`);
  }

  return { id, reasoning, warnings };
}

export function assertModelPolicyValid(policy: ModelPolicy): void {
  const bad: string[] = [];
  const seen = new Set<string>();
  const validTiers = new Set<ModelTier>(["high", "medium", "low"]);
  for (const entry of policy.allow ?? []) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id.length === 0) {
      bad.push(`  an allow-list entry has a blank/missing model id`);
      continue;
    }
    if (seen.has(id)) {
      bad.push(`  model "${id}" is allow-listed more than once`);
    } else {
      seen.add(id);
    }
    if (!validTiers.has(entry.tier)) {
      bad.push(`  model "${id}": unknown tier "${String(entry.tier)}" (must be "high" | "medium" | "low")`);
    }
    if (policy.providerDeny?.includes(modelProviderOf(id))) {
      bad.push(`  model "${id}" is allow-listed but its vendor ("${modelProviderOf(id)}") is also in providerDeny — contradictory`);
    }
  }
  if (policy.reasoningCeiling !== undefined && reasoningRank(policy.reasoningCeiling) === -1) {
    bad.push(`  reasoningCeiling "${String(policy.reasoningCeiling)}" is not a known reasoning level (${REASONING_ORDER.join(" | ")})`);
  }
  for (const p of policy.providerDeny ?? []) {
    if (typeof p !== "string" || p.trim().length === 0) {
      bad.push(`  providerDeny has a blank/missing vendor name`);
    }
  }
  if (bad.length > 0) {
    throw new Error("open-everywhere: invalid model policy:\n" + bad.join("\n") + "\n(agent/model/policy.ts / docs/deploy/configuration-reference.md)");
  }
}

export function assertRoutesWithinPolicy(domains: readonly Domain[], roles: readonly NamedKnobLayer[], policy: ModelPolicy | undefined): void {
  if (!policy) return;
  const hasAllowList = (policy.allow?.length ?? 0) > 0;
  const bad: string[] = [];
  const checkRoute = (route: ModelRoute | undefined, where: string): void => {
    if (!route) return;
    if (route.id !== undefined) {
      if (isProviderDenied(route.id, policy)) {
        bad.push(`  ${where}: model "${route.id}" is provider-denied by policy`);
      } else if (hasAllowList && !policy.allow!.some((a) => a.id === route.id)) {
        bad.push(`  ${where}: model "${route.id}" is not in the org allow-list`);
      }
    }
    if (route.tier !== undefined && hasAllowList && pickTierModel(route.tier, policy) === undefined) {
      bad.push(`  ${where}: tier "${route.tier}" has no usable allow-listed model`);
    }
  };
  for (const d of domains) {
    checkRoute(d.models?.primary, `domain "${d.name}" primary route`);
    checkRoute(d.models?.utility, `domain "${d.name}" utility route`);
  }
  for (const r of roles) {
    checkRoute(r.models?.primary, `role "${r.name}" primary route`);
    checkRoute(r.models?.utility, `role "${r.name}" utility route`);
  }
  if (bad.length > 0) {
    throw new Error("open-everywhere: model route(s) outside the org model-policy envelope:\n" + bad.join("\n") + "\n(agent/model/policy.ts / docs/deploy/configuration-reference.md)");
  }
}
