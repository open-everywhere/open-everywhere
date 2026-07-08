import {
  defineDomain,
  domainForChannel,
  assertChannelExclusivity,
  assertDomainsValid,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import { defineMemorySilo, assertSilosValid, type MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";
import { applyRoleDefaults } from "@open-everywhere/core/agent/roles/role.js";
import { loadRoles } from "../roles/roles.js";

const silos: MemorySilo[] = [
  defineMemorySilo({ name: "org-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-brain", provider: "postgres" }),

  defineMemorySilo({ name: "e2e-b-brain", provider: "postgres" }),

];

const rawDomains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", nameDropWake: true, admins: ["U0EXOWNER", "U0EXUSER002", "300000000000000104"] }),

  defineDomain({ name: "dm", match: "dm", includeOrg: "readonly",
    models: { primary: { id: "deepseek/deepseek-v4-flash" } } }),

  defineDomain({
    name: "e2e",
    channels: ["slack/T0EXAMPLE/C0EXCHAN003", "discord/1300000000000000100/1300000000000000101"],
    memory: "e2e-brain",
    nameDropWake: true,
    models: { primary: { id: "deepseek/deepseek-v4-flash" } },
  }),

  defineDomain({
    name: "e2e-b",
    channels: ["slack/T0EXAMPLE/C0EXCHAN005"],
    memory: "e2e-b-brain",
    models: { primary: { id: "deepseek/deepseek-v4-flash" } },
  }),

];

const domains: Domain[] = applyRoleDefaults(rawDomains, loadRoles());

assertChannelExclusivity(domains);
assertDomainsValid(domains);
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
