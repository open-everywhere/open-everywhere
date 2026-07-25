import type { Channel } from "eve/channels";
import type { TelegramReceiveTarget } from "eve/channels/telegram";
import type { DiscordReceiveTarget } from "eve/channels/discord";
import type { SessionMode } from "../access/resolver.js";
import type { Routine } from "../routines/routine.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export interface DispatchTarget {
  readonly channel: Channel<any, any, any>;
  readonly target: { channelId: string; threadTs?: string } | TelegramReceiveTarget | DiscordReceiveTarget | Readonly<Record<string, unknown>>;
  readonly mode: SessionMode;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface RoutineDispatchProvider {
  readonly resolveTarget: (routine: Routine) => DispatchTarget | null;
}

const ROUTINE_DISPATCH: Map<string, RoutineDispatchProvider> = new Map();

export function registerRoutineDispatch(platform: string, provider: RoutineDispatchProvider): void {
  if (!admitProviderRegistration(platform, "routine-dispatch")) return;
  ROUTINE_DISPATCH.set(platform, provider);
}

export function resolveRegisteredRoutineDispatch(platform: string): RoutineDispatchProvider | undefined {
  return ROUTINE_DISPATCH.get(platform);
}
