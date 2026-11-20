import { windowedDomainFor, windowIdFor, windowModeFor, type Domain } from "../memory/domain.js";
import {
  formatWindowToken,
  isWindowToken,
  seatWindowKey,
  windowKeyForDomain,
  saltSupervisorGeneration,
  parseDmSeatToken,
  dmSeatRegistryKey,
  dmAnchorDomain,
} from "./window-key.js";

export const UNIFIED_CHANNEL_NAME = "unified";

export function effectiveEveToken(channelName: string, rawToken: string): string {
  return `${channelName}:${rawToken}`;
}

export function unifiedSupervisorSentinel(generation: number): string {
  return `oe-sup:g${generation}`;
}

export function unifiedSupervisorToken(domainName: string, generation: number): string {
  return formatWindowToken(windowKeyForDomain(domainName, generation));
}

// Strict on purpose: a dispatch address takes the bare token, and eve adds the `unified:` namespace.
export function isUnifiedSupervisorToken(token: unknown): token is string {
  return isWindowToken(token);
}

// The three readers below resolve through seatWindowKey, so they accept the bare token and eve's
// `unified:`-namespaced token alike.
export function unifiedDomainFromToken(token: unknown): string | undefined {
  return seatWindowKey(token)?.domain;
}

export function unifiedWindowFromToken(token: unknown): string | undefined {
  return seatWindowKey(token)?.windowId;
}

export function unifiedGenerationFromToken(token: unknown): number | undefined {
  return seatWindowKey(token)?.generation;
}

const UNIFIED_DOMAIN_KEY_PREFIX = "oe-domain::";

export function unifiedDomainSessionKey(windowId: string): string {
  return `${UNIFIED_DOMAIN_KEY_PREFIX}${windowId}`;
}

export function dmWindowRegistryKey(dmSurfaceKey: string): string {
  return unifiedDomainSessionKey(dmAnchorDomain(dmSurfaceKey));
}

export function domainFromSessionKey(key: string): string | undefined {
  return key.startsWith(UNIFIED_DOMAIN_KEY_PREFIX) ? key.slice(UNIFIED_DOMAIN_KEY_PREFIX.length) : undefined;
}

export function isSupervisorToken(token: unknown): token is string {
  return typeof token === "string" && token.includes(":oe-sup:g");
}

export function standingSeatRegistryKey(token: unknown, domainKey: string): string | undefined {
  if (isSupervisorToken(token)) {
    const windowId = unifiedWindowFromToken(token);
    return windowId !== undefined ? unifiedDomainSessionKey(windowId) : domainKey;
  }
  const dm = parseDmSeatToken(token);
  return dm ? dmSeatRegistryKey(dm.channelId) : undefined;
}

export interface SupervisorGrain {
  readonly unified: boolean;
  readonly registryKey: string;
  readonly domainName?: string;
  readonly singleWindow?: true;
  readonly windowId?: string;
}

export function grainUsesUnifiedWindow(grain: SupervisorGrain): boolean {
  return grain.singleWindow === true || grain.windowId !== undefined;
}

export function supervisorGrainFor(surfaceKey: string, domains: readonly Domain[]): SupervisorGrain {
  const domain = windowedDomainFor(surfaceKey, domains);
  if (!domain) return { unified: false, registryKey: surfaceKey };
  const grouped = windowIdFor(surfaceKey, domains);
  const unifiedMode = grouped === undefined && windowModeFor(surfaceKey, domains) === "unified";
  const explicitWindow = grouped ?? (unifiedMode ? undefined : surfaceKey);
  const windowId = explicitWindow ?? domain.name;
  return {
    unified: true,
    registryKey: unifiedDomainSessionKey(windowId),
    domainName: domain.name,
    ...(unifiedMode ? { singleWindow: true as const } : {}),
    ...(explicitWindow !== undefined ? { windowId: explicitWindow } : {}),
  };
}

export function supervisorTokenForGrain(grain: SupervisorGrain, generation: number, perContainer: () => string): string {
  if (grain.unified && grain.domainName !== undefined) {
    return formatWindowToken({ domain: grain.domainName, windowId: grain.windowId ?? grain.domainName, generation });
  }
  return perContainer();
}

export function mintRotationToken(grain: SupervisorGrain, generation: number, perContainer: () => string): string {
  return saltSupervisorGeneration(supervisorTokenForGrain(grain, generation, perContainer));
}
