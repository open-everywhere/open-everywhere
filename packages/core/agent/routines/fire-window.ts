import type { RouteHandlerArgs } from "eve/channels";
import { getConfig } from "../access/config.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import type { Domain } from "../memory/domain.js";
import {
  grainUsesUnifiedWindow,
  mintRotationToken,
  standingSeatRegistryKey,
  supervisorGrainFor,
  type SupervisorGrain,
} from "../channels/unified-supervisor.js";
import { claimRuntimeRotation } from "../channels/runtime-rotation.js";
import { divertToUnifiedWindow } from "../channels/unified.js";
import {
  isUnifiedWakeOrigin,
  mintWakeId,
  unifiedThreadRef,
  OE_GRAIN_ATTR,
  type UnifiedWakeOrigin,
} from "../channels/unified-window.js";
import { formatWindowToken, threadSeatWindowId } from "../channels/window-key.js";
import { NO_REPLY_SENTINEL } from "../channels/normalized-wake.js";
import { OE_REQUESTER_ATTR, OE_REQUESTER_CANDIDATES_ATTR, REQUESTER_UNVERIFIED } from "../access/requester-identity.js";
import { ROUTINE_MARKER } from "./routine.js";

export const TRIGGERED_FIRE_GRAIN = "thread" as const;

export function jobFireSeatKey(routineId: string, generation = 1): string {
  const g = Number.isInteger(generation) && generation > 1 ? generation : 1;
  return `job/${routineId.replace(/:/g, "_")}${g > 1 ? `/g${g}` : ""}`;
}
export function runFireSeatKey(wakeId: string): string {
  return `run/${wakeId.replace(/:/g, "_")}`;
}

export function isJobFireSeat(seatKey: string): boolean {
  return seatKey.startsWith("job/");
}

export function isRunFireSeatWindowId(windowId: string): boolean {
  return /(?:^|\/)run\/[^/]+$/.test(windowId);
}

export function fireReplyMandate(wakeId: string): string {
  return (
    "<system-reminder>\n" +
    "This turn was started by a TRIGGER, not by a message, so there is no wake envelope above this " +
    `line and no one is going to send you one: the \`wake-id\` for this fire is \`${wakeId}\`.\n` +
    "You are in a cross-surface window, so anything you have to say MUST be delivered by CALLING THE " +
    "`reply` TOOL with `wake` set to that exact id — your turn-final text is not posted here. " +
    `Choosing to stay silent is still fine (end with ${NO_REPLY_SENTINEL}, or call the no_reply tool). ` +
    "But do NOT go silent because you could not find a wake-id, and never guess one: it is the id on " +
    "this line, and a guessed id is refused.\n" +
    "</system-reminder>"
  );
}

export function renderFireWindowMessage(
  message: string,
  wakeId: string,
  attributes: Readonly<Record<string, unknown>> = {},
): string {
  if (attributes[ROUTINE_MARKER.silent] === "true") return message;
  return `${message}\n\n${fireReplyMandate(wakeId)}`;
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
  readonly registryStore?: Pick<OperationalStore, "getChannelSession" | "rotateChannelSession" | "touchChannelSession">;
  readonly claimRuntimeRotation?: typeof claimRuntimeRotation;
  readonly now?: () => string;
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

export async function healFireParentGeneration(
  org: string,
  grain: SupervisorGrain,
  atIso: string,
  store: Pick<OperationalStore, "getChannelSession" | "rotateChannelSession">,
): Promise<number | undefined> {
  if (!grain.unified || grain.domainName === undefined) return undefined;
  const existing = await store.getChannelSession(org, grain.registryKey);
  if (existing === null) return undefined;
  const current = Number.isInteger(existing.generation) && existing.generation > 0 ? existing.generation : 0;
  const next = current + 1;
  const row = await store.rotateChannelSession(
    org,
    grain.registryKey,
    mintRotationToken(grain, next, () => {
      throw new Error("healFireParentGeneration: a per-container token is unreachable behind the unified grain guard");
    }),
    atIso,
  );
  return row.generation;
}

export async function adoptJobFireSeat(
  org: string,
  registryKey: string,
  token: string,
  atIso: string,
  store: Pick<OperationalStore, "getChannelSession" | "rotateChannelSession" | "touchChannelSession">,
): Promise<void> {
  try {
    const existing = await store.getChannelSession(org, registryKey);
    if (!existing || existing.token !== token) {
      await store.rotateChannelSession(org, registryKey, token, atIso);
    } else {
      await store.touchChannelSession(org, registryKey, atIso);
    }
  } catch (err) {
    console.warn(`[open-everywhere:fire-window] job-seat registry adoption skipped for ${registryKey}: ${String(err)}`);
  }
}

export async function divertTriggeredFire(
  to: RouteHandlerArgs["to"],
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
  const now = deps.now ?? (() => new Date().toISOString());
  const registryStore = () => deps.registryStore ?? getOperationalStore();
  const current = await (deps.generationFor ?? liveGeneration)(org, grain.registryKey);
  const planFor = (generation: number): FireWindowPlan | null =>
    planFireWindow({ surfaceKey: input.surfaceKey, origin: input.origin, seatKey: input.seatKey, domains, generation, armed });
  if (planFor(current) === null) return false;
  const atIso = now();
  const runtimeChanged = await (deps.claimRuntimeRotation ?? claimRuntimeRotation)({
    org,
    registryKey: grain.registryKey,
    surfaceKey: input.surfaceKey,
    atIso,
  });
  const healed = runtimeChanged ? await healFireParentGeneration(org, grain, atIso, registryStore()) : undefined;
  const plan = planFor(healed ?? current);
  if (!plan) return false;
  if (isJobFireSeat(input.seatKey)) {
    const registryKey = standingSeatRegistryKey(plan.token, grain.registryKey);
    if (registryKey !== undefined) {
      await adoptJobFireSeat(org, registryKey, plan.token, atIso, registryStore());
    }
  }
  const attributes: Record<string, unknown> = {
    ...(input.auth.attributes ?? {}),
    [OE_GRAIN_ATTR]: TRIGGERED_FIRE_GRAIN,
    [OE_REQUESTER_ATTR]: REQUESTER_UNVERIFIED,
  };
  delete attributes[OE_REQUESTER_CANDIDATES_ATTR];
  const wakeId = input.wakeId ?? mintWakeId();
  await (deps.divert ?? divertToUnifiedWindow)(to, {
    message: renderFireWindowMessage(input.message, wakeId, input.auth.attributes ?? {}),
    token: plan.token,
    window: { wakeId, origin: input.origin, addressing: "direct-mention" },
    surfaceKey: input.surfaceKey,
    auth: { ...input.auth, attributes },
    internalDispatch: true,
  });
  return true;
}
