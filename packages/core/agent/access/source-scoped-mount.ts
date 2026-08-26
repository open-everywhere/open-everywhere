import { resolveWindowSources, windowGrainOf, type BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { chatArmGrain } from "./worker-seat.js";

export function sourceScopedMount(ctx: BindableContext, platform: string, domains: () => readonly Domain[]): boolean {
  let roster: readonly Domain[];
  try {
    roster = domains();
  } catch {
    return false;
  }
  return resolveWindowSources(ctx, roster).includes(platform);
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
