import type { WakeTrust } from "../channels/wake-envelope.js";
import type { BindableContext } from "./binding.js";
import { bindFrom } from "./binding.js";
import { criteriaDomain, domainForChannel, type Domain } from "../memory/domain.js";
import { getConfig } from "../access/config.js";

export interface WakeTrustFacts {
  readonly authorIsBot: boolean;
  readonly authorId?: string;
  readonly surfaceInternal: boolean;
  readonly authorIsAdmin: boolean;
}

export function wakeTrustFor(f: WakeTrustFacts): WakeTrust {
  if (f.authorIsBot) return "relay";
  if (!f.authorId) return "relay";
  if (!f.surfaceInternal) return "relay";
  return f.authorIsAdmin ? "principal" : "peer";
}

export function wakeAuthorIsAdmin(
  authorId: string | undefined,
  channelKey: string | undefined,
  domains: readonly Domain[],
): boolean {
  if (!authorId) return false;
  if (criteriaDomain("org", domains)?.admins?.includes(authorId) === true) return true;
  if (!channelKey) return false;
  return domainForChannel(channelKey, domains)?.admins?.includes(authorId) === true;
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
}): WakeTrust {
  const domains = input.domains ?? loadDomainsForWakeTrust();
  return wakeTrustFor({
    authorIsBot: input.authorIsBot,
    authorId: input.authorId,
    surfaceInternal: input.surfaceInternal,
    authorIsAdmin: wakeAuthorIsAdmin(input.authorId, input.channelKey, domains),
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
