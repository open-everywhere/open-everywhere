import type { RouteHandlerArgs } from "eve/channels";
import type { AuditInput } from "../audit/audit.js";
import { bridgeConfirmChannelInternal } from "../channels/slack-bridge.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolveRoutineTarget, type DispatchTarget } from "../schedules/routine-dispatch.js";
import { mintWakeId } from "../channels/unified-window.js";
import { listAllRoutines } from "./store.js";
import { routineFireAttributes } from "./fire-auth.js";
import { divertTriggeredFire, runFireSeatKey, type FireWindowDeps } from "./fire-window.js";
import { auditRoutineFireLost, auditRoutineSkip, type RoutineAuditDeps } from "./fire-audit.js";
import { matchesEvent, normalizeGithubEvent, eventPrompt, type NormalizedEvent } from "./events.js";
import type { Routine } from "./routine.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

const DEFAULT_MAX_FANOUT = 3;
function eventMaxFanOut(): number {
  const raw = process.env.OE_EVENT_MAX_FANOUT;
  if (raw === undefined) return DEFAULT_MAX_FANOUT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FANOUT;
}

export const DELIVERY_DEDUPE_TTL_MS = 10 * 60_000;

export function deliveryDedupeKey(deliveryId: string): string {
  return `gh-fanout:${deliveryId}`;
}

export interface GitHubFanOutDeps {
  readonly receive: RouteHandlerArgs["receive"];
  readonly org?: string;
  readonly listRoutines?: () => Promise<Routine[]>;
  readonly resolveTarget?: (r: Routine) => DispatchTarget | null;
  readonly confirmInternal?: (channelId: string) => Promise<boolean>;
  readonly markSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly now?: () => Date;
  readonly fireWindow?: FireWindowDeps;
}

let warnedDedupeStore = false;
async function liveMarkSeen(org: string, key: string, atIso: string, ttlMs: number): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, ttlMs);
  } catch (err) {
    if (!warnedDedupeStore) {
      warnedDedupeStore = true;
      console.warn(`[open-everywhere:routines] durable delivery dedupe unavailable — replays may double-fire: ${String(err)}`);
    }
    return true;
  }
}

async function fanOut(ev: NormalizedEvent, deps: GitHubFanOutDeps): Promise<void> {
  const org = deps.org ?? deploymentOrg();
  const list = deps.listRoutines ?? listAllRoutines;
  const resolveTarget = deps.resolveTarget ?? resolveRoutineTarget;
  const confirmInternal = deps.confirmInternal ?? bridgeConfirmChannelInternal;
  const auditDeps: RoutineAuditDeps = {
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.markSeen ? { markSeen: deps.markSeen } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    principalId: "github:webhook",
  };

  const matches = (await list()).filter((r) => r.org === org && r.status === "active" && matchesEvent(r, ev));
  const cap = eventMaxFanOut();
  let fired = 0;
  let unwired = 0;
  let overCap = 0;
  for (const r of matches) {
    const dest = resolveTarget(r);
    if (!dest) {
      unwired++;
      log(`event ${ev.summary} matched ${r.id} but its surface has no wired channel/target — skipped`);
      await auditRoutineSkip(r, "unresolved_target", { event: ev.event, ...(ev.action ? { action: ev.action } : {}) }, auditDeps);
      continue;
    }
    if (fired >= cap) {
      overCap++;
      log(`event ${ev.summary} matched ${r.id} but the fan-out cap (${cap}) is reached — SKIPPED (audited; an event has no "later")`);
      await auditRoutineSkip(
        r,
        "fanout_cap",
        { cap, matched: matches.length, event: ev.event, ...(ev.action ? { action: ev.action } : {}) },
        auditDeps,
      );
      continue;
    }
    const slackChannelId =
      r.surfaceKey.split("/")[0] === "slack" && typeof (dest.target as { channelId?: unknown }).channelId === "string"
        ? (dest.target as { channelId: string }).channelId
        : undefined;
    const internal = slackChannelId !== undefined && dest.mode === "channel" ? await confirmInternal(slackChannelId).catch(() => false) : false;
    const auth = {
      authenticator: "github",
      principalType: "service",
      principalId: "github:webhook",
      attributes: routineFireAttributes(r, dest.attributes, dest.mode, internal),
    };
    const message = eventPrompt(r, ev);
    const fireWakeId = mintWakeId();
    const deliver = async (): Promise<void> => {
      if (dest.origin) {
        const diverted = await divertTriggeredFire(
          deps.receive,
          { message, surfaceKey: r.surfaceKey, origin: dest.origin, seatKey: runFireSeatKey(fireWakeId), auth, wakeId: fireWakeId },
          deps.fireWindow ?? {},
        );
        if (diverted) return;
      }
      await deps.receive(dest.channel, { message, target: dest.target, auth });
    };
    await deliver().catch(async (err: unknown) => {
      log(`fire delivery failed for ${r.id} on ${r.surfaceKey}: ${String(err)}`);
      await auditRoutineFireLost(r, String(err), auditDeps);
    });
    fired++;
  }
  if (matches.length > 0) {
    log(`event "${ev.summary}": ${matches.length} matched -> ${fired} fired, ${unwired} unwired, ${overCap} over-cap (cap ${cap})`);
  }
}

export function fanOutGitHubDelivery(
  body: string,
  eventType: string,
  receive: RouteHandlerArgs["receive"],
  deliveryId?: string | null,
): Promise<void> {
  return fanOutDelivery(body, eventType, deliveryId ?? undefined, { receive });
}

export async function fanOutDelivery(
  body: string,
  eventType: string,
  deliveryId: string | undefined,
  deps: GitHubFanOutDeps,
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return;
  }
  const ev = normalizeGithubEvent(eventType, payload);
  if (!ev) return;

  if (deliveryId) {
    const org = deps.org ?? deploymentOrg();
    const markSeen = deps.markSeen ?? liveMarkSeen;
    const atIso = (deps.now?.() ?? new Date()).toISOString();
    const first = await markSeen(org, deliveryDedupeKey(deliveryId), atIso, DELIVERY_DEDUPE_TTL_MS);
    if (!first) {
      log(`delivery ${deliveryId} already fanned out — replay dropped`);
      return;
    }
  }
  await fanOut(ev, deps);
}
