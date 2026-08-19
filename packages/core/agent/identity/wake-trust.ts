import type { WakeTrust } from "../channels/wake-envelope.js";
import type { BackscrollTrustFor, NormalizedMessage } from "../channels/backscroll-window.js";
import type { BindableContext } from "./binding.js";
import { bindFrom } from "./binding.js";
import { criteriaDomain, domainForChannel, type Domain } from "../memory/domain.js";
import { rosterHasPrincipal } from "./principal-key.js";
import { getConfig } from "../access/config.js";
import { parseScopeKey } from "../access/scope-key.js";
import { isAllowlistedDriverAuthor } from "../testing/driver-allowlist.js";

export interface WakeTrustFacts {
  readonly authorIsBot: boolean;
  readonly authorId?: string;
  readonly surfaceInternal: boolean;
  readonly authorIsAdmin: boolean;
  readonly isAllowlistedDriver?: boolean;
}

export function wakeTrustFor(f: WakeTrustFacts): WakeTrust {
  if (f.authorIsBot) return f.isAllowlistedDriver ? "peer" : "relay";
  if (!f.authorId) return "unauth";
  if (!f.surfaceInternal) return "unauth";
  return f.authorIsAdmin ? "principal" : "peer";
}

export function wakeAuthorIsAdmin(
  authorId: string | undefined,
  channelKey: string | undefined,
  domains: readonly Domain[],
): boolean {
  if (!authorId || !channelKey) return false;
  const parsed = parseScopeKey(channelKey);
  const platform = parsed.kind === "tenant" || parsed.kind === "surface" || parsed.kind === "principal" ? parsed.platform : undefined;
  const tenant = parsed.kind === "tenant" || parsed.kind === "surface" ? parsed.workspace : undefined;
  const admits = (roster: readonly string[] | undefined): boolean =>
    rosterHasPrincipal(roster, platform, tenant, authorId);
  if (admits(criteriaDomain("org", domains)?.admins)) return true;
  return admits(domainForChannel(channelKey, domains)?.admins);
}

export function loadDomainsForWakeTrust(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export function resolveWakeTrust(input: {
  readonly authorIsBot: boolean;
  readonly authorId?: string;
  readonly surfaceInternal: boolean;
  readonly channelKey?: string;
  readonly domains?: readonly Domain[];
  readonly driverAllowlist?: ReadonlySet<string>;
}): WakeTrust {
  const domains = input.domains ?? loadDomainsForWakeTrust();
  const workspace = input.channelKey?.split("/")[1];
  const isAllowlistedDriver = isAllowlistedDriverAuthor(workspace, input.authorId, input.driverAllowlist);
  return wakeTrustFor({
    authorIsBot: input.authorIsBot,
    authorId: input.authorId,
    surfaceInternal: input.surfaceInternal,
    authorIsAdmin: wakeAuthorIsAdmin(input.authorId, input.channelKey, domains),
    isAllowlistedDriver,
  });
}

export function resolveWakeTrustFromContext(
  ctx: BindableContext,
  author: { readonly id?: string; readonly isBot?: boolean },
  opts?: { readonly principalFallback?: boolean; readonly domains?: readonly Domain[] },
): WakeTrust {
  try {
    const binding = bindFrom(ctx);
    const authorIsBot = author.isBot !== false;
    const authorId = author.id ?? (opts?.principalFallback === true ? binding.principalId : undefined);
    return resolveWakeTrust({
      authorIsBot,
      authorId,
      surfaceInternal: binding.trust === "internal",
      channelKey: `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`,
      domains: opts?.domains,
    });
  } catch {
    return "relay";
  }
}

export function backscrollTrustResolver(surface: {
  readonly surfaceInternal: boolean;
  readonly channelKey?: string;
  readonly domains?: readonly Domain[];
}): BackscrollTrustFor {
  return (m) =>
    resolveWakeTrust({
      authorIsBot: m.sender !== "human",
      authorId: m.authorId,
      surfaceInternal: surface.surfaceInternal,
      channelKey: surface.channelKey,
      domains: surface.domains,
    });
}
