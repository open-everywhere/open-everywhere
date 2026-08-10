import {
  defineDomain,
  domainForChannel,
  assertChannelExclusivity,
  assertDomainsValid,
  assertUnifiedDomainTrust,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import { assertSingleTenantPerTenantScopedPlatform } from "@open-everywhere/core/agent/access/tenant-admission.js";
import { defineMemorySilo, assertSilosValid, type MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";
import { assertExposedAgentsCurated } from "@open-everywhere/core/agent/memory/agents-codemod.js";
import { applyRoleDefaults } from "@open-everywhere/core/agent/roles/role.js";
import { loadRoles } from "../roles/roles.js";
import { loadAgentsOverlay } from "./agents-overlay.js";
import { UTILITY_MODEL, SUPERVISOR_MODEL } from "../model/models.js";

const silos: MemorySilo[] = [
  defineMemorySilo({ name: "org-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-b-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-ambient-brain", provider: "postgres" }),

  ...(process.env.OE_MEMORY_EVAL === "1"
    ? [
        defineMemorySilo({ name: "payments-brain", provider: "postgres", description: "payments-domain decisions — refunds, chargebacks, settlement, KYC" }),
        defineMemorySilo({ name: "platform-notes", provider: "postgres", description: "platform engineering — services, deploys, infra decisions" }),
        defineMemorySilo({ name: "misc", provider: "postgres", description: "misc" }),
        defineMemorySilo({ name: "handbook-cache", provider: "postgres", description: "company handbook — HR, expenses, security policy (read-only cache)", readOnly: true, skill: "notion" }),
      ]
    : []),

  defineMemorySilo({ name: "e2e-solo-brain", provider: "postgres", description: "solo-window e2e pack scratch brain" }),
];

const E2E_NOTION_SURFACE = "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000101";

const rawDomains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", nameDropWake: true,
    admins: ["slack/T0EXAMPLE/U0EXOWNER", "slack/T0EXAMPLE/U0EXUSER002", "discord/300000000000000104"],
    models: { supervisor: { id: SUPERVISOR_MODEL, reasoning: "low" } } }),

  defineDomain({ name: "dm", match: "dm", includeOrg: "readonly",
    models: { primary: { id: UTILITY_MODEL } } }),

  ...(process.env.OE_MEMORY_EVAL === "1"
    ? []
    : [
        defineDomain({
          name: "e2e-b",
          channels: ["slack/T0EXAMPLE/C0EXCHAN005"],
          memory: "e2e-b-brain",
          models: { primary: { id: UTILITY_MODEL } },
        }),
      ]),

  defineDomain({
    name: "e2e-unified",
    channels: ["slack/T0EXAMPLE/C0EXCHAN003", "slack/T0EXAMPLE/C0EXRANDM", "github/example-owner/e2e-scratch", "discord/1300000000000000100/1300000000000000101", "teams/7e5a0000-0000-4000-8000-000000000001/19-0exampleTeamsChannel00005119784069361745884-thread.tacv2", "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011",
      ...(process.env.OE_MEMORY_EVAL === "1" ? [] : [E2E_NOTION_SURFACE])],
    memory: "e2e-ambient-brain",
    ambientSupervisor: true,
    mode: "unified",
    engagementTier: "neutral",
    reasoningCeiling: "high",
    models: { primary: { id: UTILITY_MODEL }, supervisor: { id: SUPERVISOR_MODEL, reasoning: "medium" } },
  }),

  ...(process.env.OE_MEMORY_EVAL === "1"
    ? [
        defineDomain({
          name: "e2e-memory",
          channels: ["slack/T0EXAMPLE/C0EXCHAN005", E2E_NOTION_SURFACE],
          memory: ["payments-brain", "platform-notes", "misc", "handbook-cache"],
          ambientSupervisor: true,
          mode: "unified",
          reasoningCeiling: "high",
        }),
      ]
    : []),

  defineDomain({
    name: "e2e-solo",
    channels: [
      "slack/T0EXAMPLE/C0EXCHAN001",
      "slack/T0EXAMPLE/C0EXCHAN002",
    ],
    memory: "e2e-solo-brain",
    ambientSupervisor: true,
    mode: "solo",
    engagementTier: "neutral",
    models: { primary: { id: UTILITY_MODEL } },
  }),

  defineDomain({
    name: "e2e-connector",
    channels: ["slack/T0EXAMPLE/C0EXGENRL"],
    memory: "e2e-brain",
    ambientSupervisor: true,
    mode: "solo",
    engagementTier: "neutral",
    models: { primary: { id: UTILITY_MODEL } },
  }),

  defineDomain({
    name: "e2e-supervisor",
    channels: ["slack/T0EXAMPLE/C0EXCHAN006"],
    memory: "e2e-brain",
    ambientSupervisor: true,
    engagementTier: "neutral",
    models: { primary: { id: UTILITY_MODEL } },
  }),

  defineDomain({
    name: "e2e-cap",
    channels: ["slack/T0EXAMPLE/C0EXCHAN007"],
    memory: "e2e-brain",
    engagementTier: "neutral",
    models: { primary: { id: UTILITY_MODEL } },
  }),

];

const agentsOverlay = loadAgentsOverlay();
const mergedRawDomains: Domain[] = [...rawDomains, ...agentsOverlay.domains];
const mergedSilos: MemorySilo[] = [...silos, ...agentsOverlay.silos];

const domains: Domain[] = applyRoleDefaults(mergedRawDomains, loadRoles());

assertChannelExclusivity(domains);
assertDomainsValid(domains);
assertSingleTenantPerTenantScopedPlatform(domains);
assertUnifiedDomainTrust(domains);
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
