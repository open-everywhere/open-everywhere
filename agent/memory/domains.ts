import {
  defineDomain,
  domainForChannel,
  assertChannelExclusivity,
  assertDomainsValid,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import { defineMemorySilo, assertSilosValid, type MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";

const silos: MemorySilo[] = [
];

const domains: Domain[] = [
];

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
