import { bridgeFetchChannelDisplayName } from "../channels/slack-bridge.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { getConfig } from "../access/config.js";
import { displayTitle } from "../identity/display-title.js";

function parseScopeKey(scopeKey: string): { platform: string; workspace: string; surface?: string } | null {
  const parts = scopeKey.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.length === 0)) return null;
  return { platform: parts[0], workspace: parts[1], surface: parts[2] };
}

export type ScopeLabelResolver = (parsed: { workspace: string; surface?: string }) => Promise<string | undefined>;

const SCOPE_LABEL_RESOLVERS = new Map<string, ScopeLabelResolver>();

export function registerScopeLabelResolver(platform: string, resolver: ScopeLabelResolver): void {
  if (!admitProviderRegistration(platform, "scope-label-resolver")) return;
  SCOPE_LABEL_RESOLVERS.set(platform, resolver);
}

export async function friendlyScopeLabel(scopeKey: string): Promise<string | undefined> {
  try {
    if (!scopeKey.includes("/")) {
      const domain = getConfig().loadDomains().find((d) => d.name === scopeKey);
      return domain?.title?.trim() ? displayTitle(domain) : undefined;
    }
    const parsed = parseScopeKey(scopeKey);
    if (!parsed) return undefined;
    if (parsed.platform === "slack" && parsed.surface) {
      const name = await bridgeFetchChannelDisplayName(parsed.surface);
      return name ? `#${name}` : undefined;
    }
    const resolver = SCOPE_LABEL_RESOLVERS.get(parsed.platform);
    if (resolver) return await resolver({ workspace: parsed.workspace, surface: parsed.surface });
    return undefined;
  } catch {
    return undefined;
  }
}
