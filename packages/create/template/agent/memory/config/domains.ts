import {
  domainForChannel,
  assertChannelExclusivity,
  assertDomainsValid,
  assertUnifiedDomainTrust,
  assertWindowGroupExclusivity,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import { assertSingleTenantPerTenantScopedPlatform } from "@open-everywhere/core/agent/access/tenant-admission.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { SETTINGS_OVERRIDES } from "../../settings/settings.js";
import { defineMemorySilo, assertSilosValid, type MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";
import { assertExposedAgentsCurated } from "@open-everywhere/core/agent/memory/agents-codemod.js";
import { applyRoleDefaults } from "@open-everywhere/core/agent/roles/role.js";
import { loadRoles } from "../../roles/roles.js";
import { loadAgentsOverlay } from "./agents-overlay.js";
import { loadDomainModules } from "./domains/index.js";

const silos: MemorySilo[] = [
  defineMemorySilo({ name: "org-brain", provider: "postgres" }),

];

const agentsOverlay = loadAgentsOverlay();
const rawDomains: Domain[] = loadDomainModules();
const mergedRawDomains: Domain[] = [...rawDomains, ...agentsOverlay.domains];
const mergedSilos: MemorySilo[] = [...silos, ...agentsOverlay.silos];

const domains: Domain[] = applyRoleDefaults(mergedRawDomains, loadRoles());

assertChannelExclusivity(domains);
assertDomainsValid(domains);
assertSingleTenantPerTenantScopedPlatform(domains, getSettings(SETTINGS_OVERRIDES).identity.allowMultiTenantPrincipals);
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
