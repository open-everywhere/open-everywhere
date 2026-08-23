import { channelPlatform, isUnifiedWindowContext, resolveWindowSources, windowGrainOf, type BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { getSettings } from "../settings/settings.js";
import { chatArmGrain } from "./worker-seat.js";

export function sourceScopedToolsEnabled(): boolean {
  return getSettings().tools.sourceScopedMount;
}

export function genericReadVerbsEnabled(): boolean {
  return getSettings().tools.genericReadVerbs;
}

export function sourceScopedMount(ctx: BindableContext, platform: string, domains: () => readonly Domain[]): boolean {
  if (!sourceScopedToolsEnabled()) {
    return isUnifiedWindowContext(ctx) || channelPlatform(ctx) === platform;
  }
  return resolveWindowSources(ctx, domains()).includes(platform);
}

export function workerChatArmMount(ctx: BindableContext, platform: string, domains: () => readonly Domain[]): boolean {
  let grain;
  try {
    grain = windowGrainOf(ctx);
  } catch {
    return false;
  }
  return chatArmGrain(grain) && sourceScopedMount(ctx, platform, domains);
}
