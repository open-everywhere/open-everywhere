import { channelPlatform, isUnifiedWindowContext, resolveWindowSources, type BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";

export const OE_SOURCE_SCOPED_TOOLS_ENV = "OE_SOURCE_SCOPED_TOOLS";

export function sourceScopedToolsEnabled(): boolean {
  const raw = process.env[OE_SOURCE_SCOPED_TOOLS_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

export const OE_GENERIC_READ_VERBS_ENV = "OE_GENERIC_READ_VERBS";

export function genericReadVerbsEnabled(): boolean {
  const raw = process.env[OE_GENERIC_READ_VERBS_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

export function sourceScopedMount(ctx: BindableContext, platform: string, domains: () => readonly Domain[]): boolean {
  if (!sourceScopedToolsEnabled()) {
    return isUnifiedWindowContext(ctx) || channelPlatform(ctx) === platform;
  }
  return resolveWindowSources(ctx, domains()).includes(platform);
}
