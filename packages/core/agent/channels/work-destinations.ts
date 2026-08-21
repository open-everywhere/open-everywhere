import { resolveWindowSources, type BindableContext } from "../identity/binding.js";
import { workGrantedConnectors } from "../access/work-grant.js";
import { resolveDomainForChannel, type Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";

function callerDomains(ctx: BindableContext, domains: readonly Domain[]): readonly (Domain | undefined)[] {
  try {
    const surfaceKey = resolvePartition(ctx).surfaceKey;
    const domain = resolveDomainForChannel(surfaceKey, domains).domain;
    return domain ? [domain] : [];
  } catch {
    return [];
  }
}

export function workDestinationPlatforms(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const sources = resolveWindowSources(ctx, domains);
  const granted = workGrantedConnectors(callerDomains(ctx, domains));
  if (granted.length === 0) return sources;
  const out = [...sources];
  for (const connector of granted) {
    if (!out.includes(connector)) out.push(connector);
  }
  return out;
}
