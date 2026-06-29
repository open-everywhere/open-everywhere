import {
  defineDomain,
  domainForChannel,
  assertChannelExclusivity,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import { defineMemorySilo, type MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";
import type { OrgDefault } from "@open-everywhere/core/agent/access/config.js";

const silos: MemorySilo[] = [
];

const domains: Domain[] = [
];

const orgDefault: OrgDefault = {
  enabled: false,
};

assertChannelExclusivity(domains);

export function loadDomains(): readonly Domain[] {
  return domains;
}

export function loadSilos(): readonly MemorySilo[] {
  return silos;
}

export const ORG_DEFAULT: OrgDefault = orgDefault;

export function domainsForSurface(
  p: { workspaceKey: string; surface: string },
  list: readonly Domain[] = domains,
): string[] {
  const channelKey = `${p.workspaceKey}/${p.surface}`;
  const d = domainForChannel(channelKey, list);
  return d ? [d.name] : [];
}
