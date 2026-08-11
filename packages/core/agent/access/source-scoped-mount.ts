import { channelPlatform, isUnifiedWindowContext, resolveWindowSources, type BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { getSettings } from "../settings/settings.js";

export const OE_SOURCE_SCOPED_TOOLS_ENV = "OE_SOURCE_SCOPED_TOOLS";

export function sourceScopedToolsEnabled(): boolean {
  return getSettings().tools.sourceScopedMount;
}

export const OE_GENERIC_READ_VERBS_ENV = "OE_GENERIC_READ_VERBS";

export function genericReadVerbsEnabled(): boolean {
  return getSettings().tools.genericReadVerbs;
}

export function sourceScopedMount(ctx: BindableContext, platform: string, domains: () => readonly Domain[]): boolean {
  if (!sourceScopedToolsEnabled()) {
    return isUnifiedWindowContext(ctx) || channelPlatform(ctx) === platform;
  }
  return resolveWindowSources(ctx, domains()).includes(platform);
}
