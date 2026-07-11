import { unifiedDomainFor, type Domain } from "../memory/domain.js";

export function unifiedSupervisorSentinel(generation: number): string {
  return `oe-sup:g${generation}`;
}

export function unifiedSupervisorToken(domainName: string, generation: number): string {
  return `oe-dom:${domainName}:${unifiedSupervisorSentinel(generation)}`;
}

const UNIFIED_SUPERVISOR_TOKEN_RE = /^oe-dom:(.+):oe-sup:g(\d+)$/;

export function isUnifiedSupervisorToken(token: unknown): token is string {
  return typeof token === "string" && UNIFIED_SUPERVISOR_TOKEN_RE.test(token);
}

export function unifiedDomainFromToken(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  const m = UNIFIED_SUPERVISOR_TOKEN_RE.exec(token);
  return m ? m[1] : undefined;
}

export function unifiedGenerationFromToken(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const m = UNIFIED_SUPERVISOR_TOKEN_RE.exec(token);
  return m ? Number(m[2]) : undefined;
}

const UNIFIED_DOMAIN_KEY_PREFIX = "oe-domain::";

export function unifiedDomainSessionKey(domainName: string): string {
  return `${UNIFIED_DOMAIN_KEY_PREFIX}${domainName}`;
}

export function domainFromSessionKey(key: string): string | undefined {
  return key.startsWith(UNIFIED_DOMAIN_KEY_PREFIX) ? key.slice(UNIFIED_DOMAIN_KEY_PREFIX.length) : undefined;
}

export interface SupervisorGrain {
  readonly unified: boolean;
  readonly registryKey: string;
  readonly domainName?: string;
}

export function supervisorGrainFor(surfaceKey: string, domains: readonly Domain[]): SupervisorGrain {
  const domain = unifiedDomainFor(surfaceKey, domains);
  if (!domain) return { unified: false, registryKey: surfaceKey };
  return { unified: true, registryKey: unifiedDomainSessionKey(domain.name), domainName: domain.name };
}

export function supervisorTokenForGrain(grain: SupervisorGrain, generation: number, perContainer: () => string): string {
  return grain.unified && grain.domainName !== undefined ? unifiedSupervisorToken(grain.domainName, generation) : perContainer();
}
