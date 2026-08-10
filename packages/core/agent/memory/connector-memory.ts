import type { MemorySilo } from "./silo.js";
import type { Domain } from "./domain.js";
import { memoryRefs } from "./domain.js";

export type ConnectorMemoryMode = "materialise" | "read-write" | "skill";

export interface DomainMemoryGrants {
  readonly connectors: readonly string[];
  readonly repos: readonly string[];
}

export interface ConnectorMemoryCapability {
  readonly provider: string;
  readonly connector: string;
  readonly mode: ConnectorMemoryMode;
  readonly subject: "app-principal";
  readonly containerLabel: string;
  readonly skill?: string;
  readonly assertContainerGranted?: (silo: MemorySilo, grants: DomainMemoryGrants) => string | null;
}

const REGISTRY = new Map<string, ConnectorMemoryCapability>();

export function registerConnectorMemory(cap: ConnectorMemoryCapability): void {
  if (cap.subject !== "app-principal") {
    throw new Error(
      `connector-owned memory "${cap.provider}": subject must be "app-principal" (got ${JSON.stringify(cap.subject)}) — ` +
        `a shared domain brain is never materialised through a user-subject token (memory/connector-memory.ts).`,
    );
  }
  const existing = REGISTRY.get(cap.provider);
  if (existing && existing.connector !== cap.connector) {
    throw new Error(
      `connector-owned memory "${cap.provider}" is already declared against connector "${existing.connector}" ` +
        `and is being re-declared against "${cap.connector}" — two provider packages cannot own one backing id.`,
    );
  }
  REGISTRY.set(cap.provider, cap);
}

export function connectorMemoryFor(providerId: string | undefined): ConnectorMemoryCapability | undefined {
  return providerId ? REGISTRY.get(providerId) : undefined;
}

export function connectorMemoryCapabilities(): readonly ConnectorMemoryCapability[] {
  return [...REGISTRY.values()].sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
}

export function resetConnectorMemoryForTest(): void {
  REGISTRY.clear();
}

export function assertConnectorMemoryGrants(
  domains: readonly Domain[],
  silos: readonly MemorySilo[],
  grantsFor: (domain: Domain) => DomainMemoryGrants | null,
): void {
  const byName = new Map(silos.map((s) => [s.name, s]));
  const problems: string[] = [];

  for (const domain of domains) {
    let grants: DomainMemoryGrants | null = null;
    let resolved = false;
    for (const ref of memoryRefs(domain)) {
      const silo = byName.get(ref);
      if (!silo) continue;
      const cap = connectorMemoryFor(silo.provider);
      if (!cap) continue;
      if (!resolved) {
        grants = grantsFor(domain);
        resolved = true;
      }
      if (!grants) {
        problems.push(
          `  domain "${domain.name}" references silo "${silo.name}" (${cap.provider}-backed) but the domain has NO ` +
            `resolvable access grants — memory rides the same route as connector access, so bind a bundle granting ` +
            `the "${cap.connector}" connector to this domain (access/bundles.ts).`,
        );
        continue;
      }
      if (!grants.connectors.includes(cap.connector)) {
        problems.push(
          `  domain "${domain.name}" references silo "${silo.name}" (${cap.provider}-backed) but does not hold the ` +
            `"${cap.connector}" connector grant — a memory projection IS read access, so it must be DECLARED on the ` +
            `connector plane rather than smuggled in through silo config. Grant "${cap.connector}" to this domain ` +
            `(bundle.connectors / bundle.providers) or drop the silo from the domain's memory list.`,
        );
        continue;
      }
      const containerProblem = cap.assertContainerGranted?.(silo, grants);
      if (containerProblem) problems.push(`  domain "${domain.name}" / silo "${silo.name}": ${containerProblem}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "open-everywhere: connector-owned memory silo(s) reach past their domain's grants:\n" +
        problems.join("\n") +
        "\n(memory/connector-memory.ts / docs/capabilities/memory.md — the prefetch invariant)",
    );
  }
}
