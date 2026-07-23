import {
  defineDomain,
  domainForChannel,
  assertChannelExclusivity,
  assertDomainsValid,
  assertUnifiedDomainTrust,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import { defineMemorySilo, assertSilosValid, type MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";
import { applyRoleDefaults } from "@open-everywhere/core/agent/roles/role.js";
import { loadRoles } from "../roles/roles.js";

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

const rawDomains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", nameDropWake: true,
    admins: ["U0EXOWNER", "U0EXUSER002", "300000000000000104"],
    models: { supervisor: { id: "deepseek/deepseek-v4-flash", reasoning: "low" } } }),

  defineDomain({ name: "dm", match: "dm", includeOrg: "readonly",
    models: { primary: { id: "deepseek/deepseek-v4-flash" } } }),

  ...(process.env.OE_MEMORY_EVAL === "1"
    ? []
    : [
        defineDomain({
          name: "e2e-b",
          channels: ["slack/T0EXAMPLE/C0EXCHAN005"],
          memory: "e2e-b-brain",
          models: { primary: { id: "deepseek/deepseek-v4-flash" } },
        }),
      ]),

  defineDomain({
    name: "e2e-unified",
    channels: ["slack/T0EXAMPLE/C0EXCHAN003", "slack/T0EXAMPLE/C0EXRANDM", "github/example-owner/e2e-scratch", "discord/1300000000000000100/1300000000000000101", "teams/7e5a0000-0000-4000-8000-000000000001/19-0exampleTeamsChannel00005119784069361745884-thread.tacv2", "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011", "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000101"],
    memory: "e2e-ambient-brain",
    ambientSupervisor: true,
    mode: "unified",
    engagementTier: "neutral",
    reasoningCeiling: "high",
    models: { primary: { id: "deepseek/deepseek-v4-flash" }, supervisor: { id: "deepseek/deepseek-v4-flash", reasoning: "medium" } },
  }),

  ...(process.env.OE_MEMORY_EVAL === "1"
    ? [
        defineDomain({
          name: "e2e-memory",
          channels: ["slack/T0EXAMPLE/C0EXCHAN005"],
          memory: ["payments-brain", "platform-notes", "misc", "handbook-cache"],
          ambientSupervisor: true,
          mode: "unified",
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
    models: { primary: { id: "deepseek/deepseek-v4-flash" } },
  }),

  defineDomain({
    name: "e2e-connector",
    channels: ["slack/T0EXAMPLE/C0EXGENRL"],
    memory: "e2e-brain",
    ambientSupervisor: true,
    mode: "solo",
    engagementTier: "neutral",
    models: { primary: { id: "deepseek/deepseek-v4-flash" } },
  }),

];

const domains: Domain[] = applyRoleDefaults(rawDomains, loadRoles());

assertChannelExclusivity(domains);
assertDomainsValid(domains);
assertUnifiedDomainTrust(domains);
assertSilosValid(silos);

export function loadDomains(): readonly Domain[] {
  return domains;
}

export function loadSilos(): readonly MemorySilo[] {
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
