import { resolveDomainForChannel, type Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import type { BindableContext } from "../identity/binding.js";
import { credentialOverrideFor, type CredentialBoundDomain } from "./domain-credentials.js";

export function workGrantCredential(
  domain: CredentialBoundDomain | undefined,
  connector: string,
  workRole: string,
): string | undefined {
  const declared = credentialOverrideFor(domain, connector, workRole);
  if (!declared) return undefined;
  return declared.use;
}

export function hasWorkGrant(
  domain: CredentialBoundDomain | undefined,
  connector: string,
  workRole: string,
): boolean {
  return workGrantCredential(domain, connector, workRole) !== undefined;
}

export type WorkDomainResolver = (surfaceKey: string, domains: readonly Domain[]) => Domain | undefined;

const resolveByChannelKey: WorkDomainResolver = (surfaceKey, domains) => resolveDomainForChannel(surfaceKey, domains).domain;

export function callerWorkDomain(
  ctx: BindableContext,
  domains: () => readonly Domain[],
  resolveDomain: WorkDomainResolver = resolveByChannelKey,
): Domain | undefined {
  try {
    return resolveDomain(resolvePartition(ctx).surfaceKey, domains());
  } catch {
    return undefined;
  }
}

export function callerWorkGrant(
  ctx: BindableContext,
  connector: string,
  workRole: string,
  domains: () => readonly Domain[],
  resolveDomain?: WorkDomainResolver,
): string | undefined {
  return workGrantCredential(callerWorkDomain(ctx, domains, resolveDomain), connector, workRole);
}

export interface WorkRole {
  readonly connector: string;
  readonly role: string;
}

export const WORK_ROLES: readonly WorkRole[] = [
  { connector: "notion", role: "team-key" },
  { connector: "linear", role: "workspace" },
];

export const GITHUB_CONNECTOR = "github";

export function hasGithubWorkGrant(repos: readonly string[]): boolean {
  return repos.length > 0;
}

export function workGrantedConnectors(
  domains: readonly (CredentialBoundDomain | undefined)[],
  repos: readonly string[] = [],
): readonly string[] {
  const out = new Set<string>();
  for (const domain of domains) {
    for (const w of WORK_ROLES) {
      if (hasWorkGrant(domain, w.connector, w.role)) out.add(w.connector);
    }
  }
  if (hasGithubWorkGrant(repos)) out.add(GITHUB_CONNECTOR);
  return [...out].sort();
}
