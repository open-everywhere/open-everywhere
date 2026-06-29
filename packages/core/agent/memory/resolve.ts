import type { SurfaceBinding } from "../identity/binding.js";
import type { Partition } from "./partition.js";
import type { Domain } from "./domain.js";
import { isPointer, type MemorySilo } from "./silo.js";
import type { OrgDefault } from "../access/config.js";
import { SURFACE, siloTier, type Tier } from "./store.js";
import { domainForChannel, memoryRefs } from "./domain.js";
import { dbProviderId } from "./provider.js";
import { getConfig } from "../access/config.js";

export interface ResolvedMemory {
  readonly silo: MemorySilo;
  readonly tier: Tier;
  readonly readOnly: boolean;
}

export interface MemoryPlan {
  readonly reads: readonly ResolvedMemory[];
  readonly writes: readonly ResolvedMemory[];
  readonly reason: string;
}

export interface MemoryResolveConfig {
  readonly domains: readonly Domain[];
  readonly silos: readonly MemorySilo[];
  readonly orgDefault?: OrgDefault;
}

const NONE = (reason: string): MemoryPlan => ({ reads: [], writes: [], reason });

function personalSilo(): MemorySilo {
  return { name: "@personal", provider: dbProviderId() };
}

function findSilo(silos: readonly MemorySilo[], name: string, referencedBy: string): MemorySilo {
  const silo = silos.find((s) => s.name === name);
  if (!silo) {
    throw new Error(
      `memory silo "${name}" referenced by ${referencedBy} is not defined — add a ` +
        `defineMemorySilo({ name: "${name}", … }) (memory/silo.ts / docs/memory-model.md).`,
    );
  }
  return silo;
}

export function resolveMemoryPlan(
  binding: SurfaceBinding,
  partition: Partition,
  cfg: MemoryResolveConfig,
): MemoryPlan {
  if (binding.mode === "mpim") return NONE("group chat — execution-only, no memory");

  if (binding.mode === "dm") {
    const rm: ResolvedMemory = { silo: personalSilo(), tier: SURFACE, readOnly: false };
    return { reads: [rm], writes: [rm], reason: "DM — personal memory (DB)" };
  }

  if (binding.trust === "external") {
    return NONE("externally-shared / guest channel — memory disabled (trust gate)");
  }

  const domain = domainForChannel(partition.surfaceKey, cfg.domains);
  const refs = domain ? memoryRefs(domain) : [];
  if (refs.length > 0) {
    const reads = refs.map((name) => {
      const silo = findSilo(cfg.silos, name, `domain "${domain!.name}"`);
      const readOnly = isPointer(silo) || silo.readOnly === true;
      return { silo, tier: siloTier(silo.name), readOnly } satisfies ResolvedMemory;
    });
    return {
      reads,
      writes: reads.filter((r) => !r.readOnly),
      reason: `domain "${domain!.name}" (${refs.length === 1 ? refs[0] : `${refs.length} silos: ${refs.join(", ")}`})`,
    };
  }

  const od = cfg.orgDefault;
  if (od?.enabled && od.memory) {
    const base = findSilo(cfg.silos, od.memory, "org default");
    const rm: ResolvedMemory = { silo: { ...base, readOnly: true }, tier: siloTier(base.name), readOnly: true };
    return { reads: [rm], writes: [], reason: "org default (read-only)" };
  }

  return NONE(
    domain
      ? `domain "${domain.name}" has no memory silo — grouping only`
      : "unassigned channel — no domain, org default off",
  );
}

export function planFor(binding: SurfaceBinding, partition: Partition): MemoryPlan {
  const cfg = getConfig();
  return resolveMemoryPlan(binding, partition, {
    domains: cfg.loadDomains(),
    silos: cfg.loadSilos(),
    orgDefault: cfg.orgDefault,
  });
}
