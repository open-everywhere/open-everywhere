export type DomainMatch = "org" | "public" | "dm";

export interface Domain {
  readonly name: string;
  readonly channels?: readonly string[];
  readonly match?: DomainMatch;
  readonly memory?: string | readonly string[];
  readonly includeOrg?: "readonly" | "inherit";
  readonly bundle?: string;
}

export function memoryRefs(domain: Domain): string[] {
  if (!domain.memory) return [];
  return Array.isArray(domain.memory) ? [...domain.memory] : [domain.memory as string];
}

export function defineDomain(domain: Domain): Domain {
  return domain;
}

export function domainForChannel(channelKey: string, domains: readonly Domain[]): Domain | undefined {
  return domains.find((d) => d.channels?.includes(channelKey));
}

export function criteriaDomain(match: DomainMatch, domains: readonly Domain[]): Domain | undefined {
  return domains.find((d) => d.match === match);
}

export function assertChannelExclusivity(domains: readonly Domain[]): void {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const d of domains) {
    for (const ch of d.channels ?? []) {
      const prev = owner.get(ch);
      if (prev !== undefined && prev !== d.name) {
        clashes.push(`  "${ch}" is in both "${prev}" and "${d.name}"`);
      } else {
        owner.set(ch, d.name);
      }
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      "open-everywhere: a channel may belong to at most one memory domain, but:\n" +
        clashes.join("\n") +
        "\nRemove the channel from all but one domain (docs/memory-model.md).",
    );
  }
}

export function assertDomainsValid(domains: readonly Domain[]): void {
  const bad: string[] = [];
  const byMatch = new Map<DomainMatch, string>();
  let hasOrg = false;
  for (const d of domains) {
    const hasChannels = d.channels !== undefined;
    const hasMatch = d.match !== undefined;
    if (hasChannels === hasMatch) {
      bad.push(`  "${d.name}" must have EITHER channels (explicit) OR match (criteria), not ${hasChannels ? "both" : "neither"}`);
    }
    if (hasMatch) {
      if (d.match === "org") hasOrg = true;
      const prev = byMatch.get(d.match!);
      if (prev) bad.push(`  match "${d.match}" is claimed by both "${prev}" and "${d.name}" (at most one per match value)`);
      else byMatch.set(d.match!, d.name);
      if (d.includeOrg && (d.match === "org" || d.match === "public")) {
        bad.push(`  "${d.name}" (match "${d.match}") must not set includeOrg (${d.match === "org" ? "self-reference" : "would leak org memory to the external surface"})`);
      }
    }
  }
  for (const d of domains) {
    if (d.includeOrg && !hasOrg) {
      bad.push(`  "${d.name}" sets includeOrg but no { match: "org" } domain is defined to include`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid memory domain(s):\n" + bad.join("\n") + "\n(memory/domain.ts / docs/memory-model.md)",
    );
  }
}
