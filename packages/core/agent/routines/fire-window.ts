import type { RouteHandlerArgs } from "eve/channels";
import { getConfig } from "../access/config.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import type { Domain } from "../memory/domain.js";
import { grainUsesUnifiedWindow, supervisorGrainFor } from "../channels/unified-supervisor.js";
import { divertToUnifiedWindow } from "../channels/unified.js";
import {
  isUnifiedWakeOrigin,
  mintWakeId,
  unifiedThreadRef,
  OE_GRAIN_ATTR,
  type UnifiedWakeOrigin,
} from "../channels/unified-window.js";
import { formatWindowToken, threadSeatWindowId } from "../channels/window-key.js";

export const TRIGGERED_FIRE_GRAIN = "thread" as const;

export function jobFireSeatKey(routineId: string): string {
  return `job/${routineId.replace(/:/g, "_")}`;
}
export function runFireSeatKey(wakeId: string): string {
  return `run/${wakeId.replace(/:/g, "_")}`;
}

export interface FireWindowPlan {
  readonly token: string;
  readonly domain: string;
}

export function planFireWindow(input: {
  readonly surfaceKey: string;
  readonly origin: UnifiedWakeOrigin;
  readonly seatKey: string;
  readonly domains: readonly Domain[];
  readonly generation: number;
  readonly armed: boolean;
}): FireWindowPlan | null {
  if (!input.armed) return null;
  if (!isUnifiedWakeOrigin(input.origin)) return null;
  const grain = supervisorGrainFor(input.surfaceKey, input.domains);
  if (!grain.unified || grain.domainName === undefined || !grainUsesUnifiedWindow(grain)) return null;
  const ref = unifiedThreadRef(input.origin);
  if (!ref || ref.channelKey.length === 0) return null;
  const seat = input.seatKey.replace(/:/g, "_");
  if (seat.length === 0) return null;
  return {
    token: formatWindowToken({
      domain: grain.domainName,
      windowId: threadSeatWindowId(ref.channelKey, seat),
      generation: input.generation,
    }),
    domain: grain.domainName,
  };
}

export interface FireWindowDeps {
  readonly loadDomains?: () => readonly Domain[];
  readonly generationFor?: (org: string, registryKey: string) => Promise<number>;
  readonly org?: string;
  readonly armed?: boolean;
  readonly divert?: typeof divertToUnifiedWindow;
}

function liveDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

async function liveGeneration(org: string, registryKey: string): Promise<number> {
  try {
    const row = await getOperationalStore().getChannelSession(org, registryKey);
    return row && Number.isInteger(row.generation) && row.generation > 0 ? row.generation : 1;
  } catch {
    return 1;
  }
}

export async function divertTriggeredFire(
  receive: RouteHandlerArgs["receive"],
  input: {
    readonly message: string;
    readonly surfaceKey: string;
    readonly origin: UnifiedWakeOrigin;
    readonly seatKey: string;
    readonly auth: { readonly attributes?: Record<string, unknown> };
    readonly wakeId?: string;
  },
  deps: FireWindowDeps = {},
): Promise<boolean> {
  const org = deps.org ?? deploymentOrg();
  const armed = deps.armed ?? oneshotAgentEnabled();
  if (!armed) return false;
  const domains = (deps.loadDomains ?? liveDomains)();
  const grain = supervisorGrainFor(input.surfaceKey, domains);
  if (!grain.unified || grain.domainName === undefined || !grainUsesUnifiedWindow(grain)) return false;
  const generation = await (deps.generationFor ?? liveGeneration)(org, grain.registryKey);
  const plan = planFireWindow({
    surfaceKey: input.surfaceKey,
    origin: input.origin,
    seatKey: input.seatKey,
    domains,
    generation,
    armed,
  });
  if (!plan) return false;
  const attributes: Record<string, unknown> = { ...(input.auth.attributes ?? {}), [OE_GRAIN_ATTR]: TRIGGERED_FIRE_GRAIN };
  await (deps.divert ?? divertToUnifiedWindow)(receive, {
    message: input.message,
    token: plan.token,
    window: { wakeId: input.wakeId ?? mintWakeId(), origin: input.origin, addressing: "direct-mention" },
    surfaceKey: input.surfaceKey,
    auth: { ...input.auth, attributes },
  });
  return true;
}
