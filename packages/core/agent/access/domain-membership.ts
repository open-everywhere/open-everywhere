import { admitProviderRegistration } from "./provider-selection.js";
import type { UnifiedWakeOrigin } from "../channels/unified-window.js";

export interface DomainMembershipRoom {
  readonly domain: string;
  readonly surfaceKey: string;
  readonly origin: UnifiedWakeOrigin;
}

export interface DomainMembershipAnswer {
  readonly fullMember: boolean;
  readonly rooms: readonly DomainMembershipRoom[];
}

export interface DomainMembershipQuery {
  readonly principalId: string;
  readonly workspaceKey: string;
}

export type DomainMembershipProbe = (query: DomainMembershipQuery) => Promise<DomainMembershipAnswer>;

const REGISTRY = new Map<string, DomainMembershipProbe>();

export function registerDomainMembershipProbe(platform: string, probe: DomainMembershipProbe): void {
  if (!admitProviderRegistration(platform, "domain-membership-probe")) return;
  REGISTRY.set(platform, probe);
}

export function domainMembershipProbe(platform: string | undefined): DomainMembershipProbe | undefined {
  return platform === undefined ? undefined : REGISTRY.get(platform);
}
