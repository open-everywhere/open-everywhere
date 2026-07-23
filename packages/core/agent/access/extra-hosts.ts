const REGISTRY = new Map<string, ReadonlySet<string>>();

export function registerExtraEgressHosts(source: string, hosts: readonly string[]): void {
  REGISTRY.set(source, new Set(hosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)));
}

export function extraEgressHosts(): string[] {
  const out = new Set<string>();
  for (const hosts of REGISTRY.values()) for (const h of hosts) out.add(h);
  return [...out];
}

export function resetExtraEgressHostsForTest(): void {
  REGISTRY.clear();
}
