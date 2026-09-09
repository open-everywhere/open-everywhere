import type { ReachableHost } from "./resolver.js";

const REGISTRY = new Map<string, ReadonlySet<string>>();

export function registerExtraEgressHosts(source: string, hosts: readonly string[]): void {
  REGISTRY.set(source, new Set(hosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)));
}

export function extraEgressHosts(): string[] {
  const out = new Set<string>();
  for (const hosts of REGISTRY.values()) for (const h of hosts) out.add(h);
  return [...out];
}

export function withExtraEgressHosts(declared: readonly ReachableHost[]): readonly ReachableHost[] {
  const extras = extraEgressHosts();
  if (extras.length === 0) return declared;
  const seen = new Set(declared.map((h) => h.host.trim().toLowerCase()));
  const added = extras.filter((h) => !seen.has(h)).map((host): ReachableHost => ({ host, viaConnection: null }));
  return added.length === 0 ? declared : [...declared, ...added];
}

export function resetExtraEgressHostsForTest(): void {
  REGISTRY.clear();
}
