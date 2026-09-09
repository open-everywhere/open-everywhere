import {
  callerWorkDomain,
  hasWorkGrant,
  resolveDomainForChannel,
  workGrantCredential,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { NOTION_PROVIDER } from "./notion-credentials.js";
import { notionPageDomain } from "./notion-scope.js";

export const NOTION_WORK_CREDENTIAL = "team-key";

export interface NotionWorkGrant {
  readonly domain: Domain;
  readonly credential: string;
}

export function notionCallerDomain(surfaceKey: string, domains: readonly Domain[]): Domain | undefined {
  const parts = surfaceKey.split("/");
  if (parts[0] === "notion" && parts.length === 3 && parts[2]) {
    return notionPageDomain(parts[1] || undefined, parts[2], domains).domain;
  }
  return resolveDomainForChannel(surfaceKey, domains).domain;
}

export function notionWorkGrant(ctx: BindableContext, domains: readonly Domain[]): NotionWorkGrant | undefined {
  const domain = callerWorkDomain(ctx, () => domains, notionCallerDomain);
  return domain ? notionWorkGrantForDomain(domain) : undefined;
}

export function notionWorkMount(ctx: BindableContext, domains: () => readonly Domain[]): boolean {
  try {
    return notionWorkGrant(ctx, domains()) !== undefined;
  } catch {
    return false;
  }
}

function notionWorkGrantForDomain(domain: Domain): NotionWorkGrant | undefined {
  if (!hasWorkGrant(domain, NOTION_PROVIDER, NOTION_WORK_CREDENTIAL)) return undefined;
  const credential = workGrantCredential(domain, NOTION_PROVIDER, NOTION_WORK_CREDENTIAL);
  return credential ? { domain, credential } : undefined;
}

export function notionWorkCredential(domain: Domain | undefined): string | undefined {
  return domain ? notionWorkGrantForDomain(domain)?.credential : undefined;
}

export function notionWorkspacesOf(domain: Domain): readonly string[] {
  const out = new Set<string>();
  for (const key of domain.reach ?? []) {
    const parts = key.split("/");
    if (parts[0] === "notion" && parts.length >= 2 && parts[1]) out.add(parts[1]);
  }
  return [...out];
}
