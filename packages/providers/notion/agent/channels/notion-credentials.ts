import {
  domainCredentialId,
  providerIntegrations,
  resolvePartition,
  type BindableContext,
  type Domain,
  type ProviderIntegration,
} from "@open-everywhere/core/agent/adapter-api.js";
import { notionPageDomain } from "./notion-scope.js";

export const NOTION_PROVIDER = "notion";

export const NOTION_CHANNEL_CREDENTIAL = "channel-key";

export const NOTION_WEBHOOK_SECRET_NAME = "NOTION_WEBHOOK_SECRET";

export function notionChannelCredentialFor(
  workspace: string | undefined,
  pageId: string | undefined,
  domains: readonly Domain[],
): string | undefined {
  if (!pageId) return undefined;
  const domain = notionPageDomain(workspace, pageId, domains).domain;
  if (!domain) return undefined;
  const id = domainCredentialId(domain, NOTION_PROVIDER, NOTION_CHANNEL_CREDENTIAL);
  return id === NOTION_CHANNEL_CREDENTIAL ? undefined : id;
}

export function notionChannelCredentialForSurface(surfaceKey: string, domains: readonly Domain[]): string | undefined {
  const parts = surfaceKey.split("/");
  if (parts.length !== 3 || parts[0] !== "notion") return undefined;
  return notionChannelCredentialFor(parts[1] || undefined, parts[2] || undefined, domains);
}

export function notionCallerCredential(ctx: BindableContext, domains: readonly Domain[]): string | undefined {
  try {
    return notionChannelCredentialForSurface(resolvePartition(ctx).surfaceKey, domains);
  } catch {
    return undefined;
  }
}

export function notionIntegrations(domains: readonly Domain[]): readonly ProviderIntegration[] {
  return providerIntegrations(domains, NOTION_PROVIDER, NOTION_CHANNEL_CREDENTIAL, NOTION_WEBHOOK_SECRET_NAME);
}
