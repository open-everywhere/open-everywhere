import { bridgeFetchChannelDisplayName } from "../channels/slack-bridge.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { getConfig } from "../access/config.js";
import { displayTitle } from "../identity/display-title.js";
import { parseScopeKey } from "../access/scope-key.js";

export type ScopeLabelResolver = (parsed: { workspace: string; surface?: string }) => Promise<string | undefined>;

const SCOPE_LABEL_RESOLVERS = new Map<string, ScopeLabelResolver>();

export function registerScopeLabelResolver(platform: string, resolver: ScopeLabelResolver): void {
  if (!admitProviderRegistration(platform, "scope-label-resolver")) return;
  SCOPE_LABEL_RESOLVERS.set(platform, resolver);
}

export async function friendlyScopeLabel(scopeKey: string): Promise<string | undefined> {
  try {
    const parsed = parseScopeKey(scopeKey);
    if (parsed.kind === "domain") {
      const domain = getConfig().loadDomains().find((d) => d.name === parsed.name);
      return domain?.title?.trim() ? displayTitle(domain) : undefined;
    }
    if (parsed.kind === "malformed") return undefined;
    if (parsed.platform === "slack" && parsed.kind === "surface") {
      const name = await bridgeFetchChannelDisplayName(parsed.surface);
      return name ? `#${name}` : undefined;
    }
    const resolver = SCOPE_LABEL_RESOLVERS.get(parsed.platform);
    if (resolver) return await resolver({ workspace: parsed.workspace, surface: parsed.kind === "surface" ? parsed.surface : undefined });
    return undefined;
  } catch {
    return undefined;
  }
}
