import {
  domainCredentialId,
  OperatorSecretNotSetError,
  resolveDomainForChannel,
  providerIntegrations,
  resolvePartition,
  type BindableContext,
  type Domain,
  type ProviderIntegration,
} from "@open-everywhere/core/agent/adapter-api.js";
import { notionSurfaceKey } from "./notion-identity.js";
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

function notionDeliveryCredential(ctx: BindableContext): string | undefined {
  const auth = ctx.session?.auth?.current ?? ctx.session?.auth?.initiator;
  const v = auth?.attributes?.credential_id;
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  return undefined;
}

export function notionCallerCredential(ctx: BindableContext, domains: readonly Domain[]): string | undefined {
  const delivered = notionDeliveryCredential(ctx);
  if (delivered) return delivered;
  try {
    return notionChannelCredentialForSurface(resolvePartition(ctx).surfaceKey, domains);
  } catch {
    return undefined;
  }
}

export function notionIntegrations(domains: readonly Domain[]): readonly ProviderIntegration[] {
  return providerIntegrations(domains, NOTION_PROVIDER, NOTION_CHANNEL_CREDENTIAL, NOTION_WEBHOOK_SECRET_NAME);
}

export type NotionSignerVerdict =
  | { readonly served: true; readonly via: "credential" | "shared-secret"; readonly expected: string }
  | { readonly served: false; readonly expected: string };

export function notionSignerServesDomain(
  owner: Domain,
  signerCredentialId: string,
  integrations: readonly ProviderIntegration[],
): NotionSignerVerdict {
  const expected = domainCredentialId(owner, NOTION_PROVIDER, NOTION_CHANNEL_CREDENTIAL);
  if (expected === signerCredentialId) return { served: true, via: "credential", expected };
  const secretOf = (credentialId: string): string | undefined => integrations.find((i) => i.credentialId === credentialId)?.inboundSecret;
  const signerSecret = secretOf(signerCredentialId);
  if (signerSecret !== undefined && secretOf(expected) === signerSecret) return { served: true, via: "shared-secret", expected };
  return { served: false, expected };
}

export function notionDeliveryClaimedDomains(
  workspaceId: string | undefined,
  pageId: string,
  domains: readonly Domain[],
): readonly Domain[] {
  const out: Domain[] = [];
  const add = (d: Domain | undefined): void => {
    if (d && !out.some((seen) => seen.name === d.name)) out.push(d);
  };
  const page = notionPageDomain(workspaceId, pageId, domains);
  if (page.via === "container") add(page.domain);
  const channel = resolveDomainForChannel(notionSurfaceKey(workspaceId, pageId), domains);
  if (channel.via.startsWith("container:")) add(channel.domain);
  return out;
}

export type NotionDeliveryScopeVerdict =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

export function notionDeliveryScopeVerdict(
  workspaceId: string | undefined,
  pageId: string,
  signerCredentialId: string | undefined,
  domains: readonly Domain[],
): NotionDeliveryScopeVerdict {
  const owners = notionDeliveryClaimedDomains(workspaceId, pageId, domains);
  if (owners.length === 0) return { ok: true, detail: "no domain reaches this page through a workspace claim" };
  if (!signerCredentialId) {
    return {
      ok: false,
      reason: `no integration's secret identified this delivery, and page ${quoteNotionId(pageId)} is claimed through workspace ${quoteNotionId(workspaceId)}`,
    };
  }
  const integrations = notionIntegrations(domains);
  let viaSharedSecret = false;
  for (const owner of owners) {
    const verdict = notionSignerServesDomain(owner, signerCredentialId, integrations);
    if (!verdict.served) {
      return {
        ok: false,
        reason:
          `page ${quoteNotionId(pageId)} reaches domain ${quoteNotionId(owner.name)} through its claim on workspace ` +
          `${quoteNotionId(workspaceId)}, and that domain is served by notion credential ${quoteNotionId(verdict.expected)} — ` +
          `this delivery was signed by ${quoteNotionId(signerCredentialId)}. A signed body cannot open a session on another domain.`,
      };
    }
    if (verdict.via === "shared-secret") viaSharedSecret = true;
  }
  const named = owners.map((d) => quoteNotionId(d.name)).join(", ");
  return {
    ok: true,
    detail: viaSharedSecret
      ? `domain ${named} is served by an integration that shares this deployment's inbound secret`
      : `domain ${named} is served by ${quoteNotionId(signerCredentialId)}`,
  };
}

function quoteNotionId(id: string | undefined): string {
  if (id === undefined) return '"(none)"';
  return JSON.stringify(id.slice(0, 64).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "?"));
}

export async function resolveNotionInboundSecret(
  name: string,
  get: (secretName: string) => Promise<{ readonly value: string }>,
  log: (message: string) => void,
): Promise<string | undefined> {
  try {
    const resolved = await get(name);
    return resolved.value.length > 0 ? resolved.value : undefined;
  } catch (err) {
    if (err instanceof OperatorSecretNotSetError) return undefined;
    const message = err instanceof Error ? err.message : String(err);
    log(`inbound signing key "${name}" did not resolve — deliveries signed with it will 401: ${message}`);
    return undefined;
  }
}
