import { unifiedDomainFor, crossSurfaceWindowEnabled, soloWindowEnabled, type Domain } from "../memory/domain.js";
import { formatWindowToken, parseWindowToken, isWindowToken, windowKeyForDomain } from "./window-key.js";

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

export function isUnifiedSupervisorToken(token: unknown): token is string {
  return isWindowToken(token);
}

export function unifiedDomainFromToken(token: unknown): string | undefined {
  return parseWindowToken(token)?.domain;
}

export function unifiedWindowFromToken(token: unknown): string | undefined {
  return parseWindowToken(token)?.windowId;
}

export function unifiedGenerationFromToken(token: unknown): number | undefined {
  return parseWindowToken(token)?.generation;
}

const UNIFIED_DOMAIN_KEY_PREFIX = "oe-domain::";

export function unifiedDomainSessionKey(windowId: string): string {
  return `${UNIFIED_DOMAIN_KEY_PREFIX}${windowId}`;
}

export function domainFromSessionKey(key: string): string | undefined {
  return key.startsWith(UNIFIED_DOMAIN_KEY_PREFIX) ? key.slice(UNIFIED_DOMAIN_KEY_PREFIX.length) : undefined;
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
  const domain = unifiedDomainFor(surfaceKey, domains);
  if (!domain) return { unified: false, registryKey: surfaceKey };
  const singleWindow = crossSurfaceWindowEnabled(surfaceKey, domains);
  const solo = !singleWindow && soloWindowEnabled(surfaceKey, domains);
  const windowId = solo ? surfaceKey : domain.name;
  return {
    unified: true,
    registryKey: unifiedDomainSessionKey(windowId),
    domainName: domain.name,
    ...(singleWindow ? { singleWindow: true as const } : {}),
    ...(solo ? { windowId } : {}),
  };
}

export function supervisorTokenForGrain(grain: SupervisorGrain, generation: number, perContainer: () => string): string {
  if (grain.unified && grain.domainName !== undefined) {
    return formatWindowToken({ domain: grain.domainName, windowId: grain.windowId ?? grain.domainName, generation });
  }
  return perContainer();
}
