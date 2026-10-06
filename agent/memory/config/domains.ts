import {
  domainForChannel,
  assertChannelExclusivity,
  assertDomainsValid,
  assertUnifiedDomainTrust,
  assertWindowGroupExclusivity,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import { assertSingleTenantPerTenantScopedPlatform } from "@open-everywhere/core/agent/access/tenant-admission.js";
import { defineMemorySilo, assertSilosValid, type MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";
import { assertExposedAgentsCurated } from "@open-everywhere/core/agent/memory/agents-codemod.js";
import { applyRoleDefaults } from "@open-everywhere/core/agent/roles/role.js";
import { loadRoles } from "../../roles/roles.js";
import { loadAgentsOverlay } from "./agents-overlay.js";
import { loadDomainModules } from "./domains/index.js";

const silos: MemorySilo[] = [
  defineMemorySilo({ name: "org-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-b-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-ambient-brain", provider: "postgres" }),

  defineMemorySilo({ name: "soak-brain", provider: "postgres" }),

  ...(process.env.OE_MEMORY_EVAL === "1"
    ? [
        defineMemorySilo({ name: "payments-brain", provider: "postgres", description: "payments-domain decisions — refunds, chargebacks, settlement, KYC" }),
        defineMemorySilo({ name: "platform-notes", provider: "postgres", description: "platform engineering — services, deploys, infra decisions" }),
        defineMemorySilo({ name: "misc", provider: "postgres", description: "misc" }),
        defineMemorySilo({ name: "handbook-cache", provider: "postgres", description: "company handbook — HR, expenses, security policy (read-only cache)", readOnly: true, skill: "notion" }),
      ]
    : []),

  defineMemorySilo({ name: "e2e-solo-brain", provider: "postgres", description: "solo-window e2e pack scratch brain" }),

  defineMemorySilo({ name: "it-memory-brain", provider: "git", description: "integration-tier memory coverage fixture (OPE-551)" }),
  defineMemorySilo({ name: "it-memory-b-brain", provider: "git", description: "OPE-551 silo-isolation negative control — must stay empty of it-memory's facts" }),
  defineMemorySilo({ name: "it-work-memory-brain", provider: "git", description: "integration-tier work-session memory-flush fixture (OPE-2341)" }),
  defineMemorySilo({ name: "it-fire-seat-brain", provider: "git", description: "integration-tier routine-fire fixture (OPE-2342)" }),
];

const agentsOverlay = loadAgentsOverlay();
const rawDomains: Domain[] = loadDomainModules();
const mergedRawDomains: Domain[] = [...rawDomains, ...agentsOverlay.domains];
const mergedSilos: MemorySilo[] = [...silos, ...agentsOverlay.silos];

const domains: Domain[] = applyRoleDefaults(mergedRawDomains, loadRoles());

assertChannelExclusivity(domains);
assertDomainsValid(domains);
assertSingleTenantPerTenantScopedPlatform(domains);
assertUnifiedDomainTrust(domains);
assertWindowGroupExclusivity(domains);
assertSilosValid(mergedSilos);
assertExposedAgentsCurated(domains, mergedSilos, agentsOverlay.specs);

export function loadDomains(): readonly Domain[] {
  return domains;
}

export function loadSilos(): readonly MemorySilo[] {
  return mergedSilos;
}

const baseDomains: Domain[] = applyRoleDefaults(rawDomains, loadRoles());
export function loadBaseDomains(): readonly Domain[] {
  return baseDomains;
}
export function loadBaseSilos(): readonly MemorySilo[] {
  return silos;
}

export function domainsForSurface(
  p: { workspaceKey: string; surface: string },
  list: readonly Domain[] = domains,
): string[] {
  const channelKey = `${p.workspaceKey}/${p.surface}`;
  const d = domainForChannel(channelKey, list);
  return d ? [d.name] : [];
}
