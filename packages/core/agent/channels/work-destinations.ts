import { resolveWindowSources, type BindableContext } from "../identity/binding.js";
import { callerWorkDomain, workGrantedConnectors } from "../access/work-grant.js";
import { resolveAccessFor } from "../access/request.js";
import type { Domain } from "../memory/domain.js";

function callerDomains(ctx: BindableContext, domains: readonly Domain[]): readonly (Domain | undefined)[] {
  const domain = callerWorkDomain(ctx, () => domains);
  return domain ? [domain] : [];
}

function grantedRepos(ctx: BindableContext): readonly string[] {
  try {
    return resolveAccessFor(ctx).repos;
  } catch {
    return [];
  }
}

export function workDestinationPlatforms(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const sources = resolveWindowSources(ctx, domains);
  const granted = workGrantedConnectors(callerDomains(ctx, domains), grantedRepos(ctx));
  if (granted.length === 0) return sources;
  const out = [...sources];
  for (const connector of granted) {
    if (!out.includes(connector)) out.push(connector);
  }
  return out;
}
