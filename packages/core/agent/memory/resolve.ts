import type { SurfaceBinding } from "../identity/binding.js";
import { domainKeyOf, type Partition } from "./partition.js";
import type { Domain } from "./domain.js";
import type { MemorySilo } from "./silo.js";
import { SURFACE, siloTier, type Tier } from "./store.js";
import { domainForChannel, criteriaDomain, memoryRefs } from "./domain.js";
import { dbProviderId, getProvider, providerById, type MemoryAccess, type MemoryProvider } from "./provider.js";
import { getConfig } from "../access/config.js";

export interface ResolvedMemory {
  readonly silo: MemorySilo;
  readonly tier: Tier;
  readonly readOnly: boolean;
  readonly access?: MemoryAccess;
}

export interface MemoryPlan {
  readonly reads: readonly ResolvedMemory[];
  readonly writes: readonly ResolvedMemory[];
  readonly reason: string;
}

export interface MemoryResolveConfig {
  readonly domains: readonly Domain[];
  readonly silos: readonly MemorySilo[];
}

const NONE = (reason: string): MemoryPlan => ({ reads: [], writes: [], reason });

function personalSilo(): MemorySilo {
  return { name: "@personal", provider: dbProviderId() };
}

export function surfaceProvider(binding: SurfaceBinding): MemoryProvider {
  return binding.mode === "dm" ? providerById(dbProviderId()) : getProvider();
}

function findSilo(silos: readonly MemorySilo[], name: string, referencedBy: string): MemorySilo {
  const silo = silos.find((s) => s.name === name);
  if (!silo) {
    throw new Error(
      `memory silo "${name}" referenced by ${referencedBy} is not defined — add a ` +
        `defineMemorySilo({ name: "${name}", … }) (memory/silo.ts / docs/capabilities/memory.md).`,
    );
  }
  return silo;
}

function resolveDomainReads(domain: Domain, cfg: MemoryResolveConfig, forceReadOnly: boolean): ResolvedMemory[] {
  const out: ResolvedMemory[] = [];
  const seen = new Set<string>();
  for (const name of memoryRefs(domain)) {
    const silo = findSilo(cfg.silos, name, `domain "${domain.name}"`);
    if (seen.has(silo.name)) continue;
    seen.add(silo.name);
    out.push({ silo, tier: siloTier(silo.name), readOnly: forceReadOnly || silo.readOnly === true, access: { domain } });
  }
  if (domain.includeOrg) {
    const org = criteriaDomain("org", cfg.domains);
    for (const name of org ? memoryRefs(org) : []) {
      const silo = findSilo(cfg.silos, name, `org default (via includeOrg on "${domain.name}")`);
      if (seen.has(silo.name)) continue;
      seen.add(silo.name);
      const readOnly = forceReadOnly || domain.includeOrg === "readonly" || silo.readOnly === true;
      out.push({ silo, tier: siloTier(silo.name), readOnly, access: org ? { domain: org } : undefined });
    }
  }
  return out;
}

function planFromReads(reads: ResolvedMemory[], reason: string): MemoryPlan {
  return { reads, writes: reads.filter((r) => !r.readOnly), reason };
}

export function resolveMemoryPlan(
  binding: SurfaceBinding,
  partition: Partition,
  cfg: MemoryResolveConfig,
): MemoryPlan {
  if (binding.mode === "mpim") return NONE("group chat — execution-only, no memory");

  if (binding.mode === "dm") {
    const personal: ResolvedMemory = { silo: personalSilo(), tier: SURFACE, readOnly: false };
    const sharedDomain = criteriaDomain(binding.trust === "internal" ? "dm" : "public", cfg.domains);
    const shared = sharedDomain ? resolveDomainReads(sharedDomain, cfg, true) : [];
    return {
      reads: [personal, ...shared],
      writes: [personal],
      reason: shared.length
        ? `DM — personal (DB) + ${binding.trust === "internal" ? "dm" : "public"} shared reads (${shared.length}, read-only)`
        : "DM — personal memory (DB)",
    };
  }

  if (binding.trust === "external") {
    const pub = criteriaDomain("public", cfg.domains);
    const reads = pub ? resolveDomainReads(pub, cfg, true) : [];
    return {
      reads,
      writes: [],
      reason: reads.length
        ? `external channel → public memory (${reads.length}, read-only)`
        : "externally-shared / guest channel — no public memory configured (trust gate)",
    };
  }

  const domain = domainForChannel(domainKeyOf(partition), cfg.domains);
  if (domain) {
    const reads = resolveDomainReads(domain, cfg, false);
    if (reads.length > 0) {
      const refs = memoryRefs(domain);
      const detail = domain.includeOrg ? `${reads.length} silos incl. org` : refs.length === 1 ? refs[0] : `${reads.length} silos`;
      return planFromReads(reads, `domain "${domain.name}" (${detail})`);
    }
    return NONE(`domain "${domain.name}" has no memory silo — grouping only`);
  }

  const org = criteriaDomain("org", cfg.domains);
  if (org) {
    const reads = resolveDomainReads(org, cfg, false);
    if (reads.length > 0) return planFromReads(reads, `org default (${reads.length})`);
  }

  return NONE("unassigned channel — no domain, no org default");
}

export function siloAccess(siloName: string, domains: readonly Domain[]): MemoryAccess {
  const owners = domains.filter((d) => memoryRefs(d).includes(siloName));
  return owners.length === 1 ? { domain: owners[0] } : {};
}

export function planFor(binding: SurfaceBinding, partition: Partition): MemoryPlan {
  const cfg = getConfig();
  return resolveMemoryPlan(binding, partition, {
    domains: cfg.loadDomains(),
    silos: cfg.loadSilos(),
  });
}
