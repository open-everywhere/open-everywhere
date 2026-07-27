import type { RouteHandlerArgs } from "eve/channels";
import type { AuditInput } from "../audit/audit.js";
import { bridgeConfirmChannelInternal } from "../channels/slack-bridge.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolveRoutineTarget, type DispatchTarget } from "../schedules/routine-dispatch.js";
import { mintWakeId } from "../channels/unified-window.js";
import { taintedFireAttrs } from "../access/taint-signal.js";
import { listAllRoutines } from "./store.js";
import { routineFireAttributes } from "./fire-auth.js";
import { divertTriggeredFire, runFireSeatKey, type FireWindowDeps } from "./fire-window.js";
import { auditRoutineFireLost, auditRoutineSkip, type RoutineAuditDeps } from "./fire-audit.js";
import { foldRoutineOutcome } from "./outcome-fold.js";
import { eventPrompt } from "./events.js";
import { normalizeDelivery, type NormalizedEvent, type TriggerDelivery } from "./event-model.js";
import { evaluateSubscription } from "./event-match.js";
import { checkEventReadGrant, eventGrantPartitions, type EventGrantDeps } from "./event-authz.js";
import {
  announceFireWithheld,
  checkFireDisclosure,
  type FireDisclosureDeps,
  type FireWithheldNoticeDeps,
} from "./fire-disclosure.js";
import {
  hydratePointer,
  newHydrationMemo,
  renderHydratedEntity,
  type HydrationDeps,
  type HydrationMemo,
  type HydrationOutcome,
} from "./entity-read.js";
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

export function deliveryDedupeKey(source: string, deliveryId: string): string {
  return `trigger:${source}:${deliveryId}`;
}

export interface TriggerAdmitDeps {
  readonly receive: RouteHandlerArgs["receive"];
  readonly org?: string;
  readonly listRoutines?: () => Promise<Routine[]>;
  readonly resolveTarget?: (r: Routine) => DispatchTarget | null;
  readonly confirmInternal?: (channelId: string) => Promise<boolean>;
  readonly markSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly now?: () => Date;
  readonly fireWindow?: FireWindowDeps;
  readonly grant?: EventGrantDeps;
  readonly hydrate?: HydrationDeps;
  readonly disclosure?: FireDisclosureDeps;
  readonly notice?: FireWithheldNoticeDeps;
}

export interface TriggerReport {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly matched: number;
  readonly fired: number;
  readonly skipped: number;
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

interface FanOutTally {
  readonly matched: number;
  readonly fired: number;
  readonly skipped: number;
}

async function fanOut(ev: NormalizedEvent, deps: TriggerAdmitDeps): Promise<FanOutTally> {
  const org = deps.org ?? deploymentOrg();
  const list = deps.listRoutines ?? listAllRoutines;
  const resolveTarget = deps.resolveTarget ?? resolveRoutineTarget;
  const confirmInternal = deps.confirmInternal ?? bridgeConfirmChannelInternal;
  const auditDeps: RoutineAuditDeps = {
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.markSeen ? { markSeen: deps.markSeen } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    principalId: `${ev.source}:webhook`,
  };

  const loseFire = async (r: Routine, error: string): Promise<void> => {
    await auditRoutineFireLost(r, error, auditDeps);
    try {
      const folded = await foldRoutineOutcome({
        marker: { id: r.id, surfaceKey: r.surfaceKey, org: r.org },
        sessionOutcome: "failed",
        at: deps.now?.() ?? new Date(),
      });
      if (folded.folded) {
        log(
          `lost fire folded for ${r.id} [${r.surfaceKey}] ` +
            `(fails=${folded.consecutiveFailures}${folded.disabled ? ", AUTO-DISABLED" : ""})`,
        );
      }
    } catch (foldErr) {
      log(`lost-fire fold skipped for ${r.id}: ${String(foldErr)}`);
    }
  };

  const candidates = (await list()).filter((r) => r.org === org && r.status === "active");
  const matches: Routine[] = [];
  let invalid = 0;
  for (const r of candidates) {
    const verdict = evaluateSubscription(r, ev);
    if ("invalid" in verdict) {
      invalid++;
      log(`event ${ev.summary} skipped ${r.id}: stored filter no longer valid (${verdict.invalid})`);
      await auditRoutineSkip(r, "filter_invalid", { why: verdict.invalid, event: ev.event }, auditDeps);
      continue;
    }
    if (verdict.match) matches.push(r);
  }
  const cap = eventMaxFanOut();
  const memo: HydrationMemo = newHydrationMemo();
  let fired = 0;
  let unwired = 0;
  let overCap = 0;
  let ungranted = 0;
  let drifted = 0;
  let hydrated = 0;
  let withheld = 0;
  let lostFires = 0;
  for (const r of matches) {
    const grant = checkEventReadGrant(ev, eventGrantPartitions(r), deps.grant ?? {});
    if (!grant.ok) {
      ungranted++;
      log(
        `event ${ev.summary} matched ${r.id} but the read grant refuses (${grant.reason}${grant.partition ? ` on ${grant.partition}` : ""}) — skipped`,
      );
      await auditRoutineSkip(
        r,
        "grant_refused",
        {
          grant: grant.reason,
          ...(grant.partition ? { partition: grant.partition } : {}),
          event: ev.event,
          ...(ev.occurredAt ? { occurredAt: ev.occurredAt } : {}),
        },
        auditDeps,
      );
      continue;
    }
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
    const disclosure = await checkFireDisclosure(r.surfaceKey, deps.disclosure ?? {});
    if (!disclosure.ok) {
      withheld++;
      log(`event ${ev.summary} matched ${r.id} but the room's audience floor is "${disclosure.floor}" — WITHHELD (audited + announced)`);
      const emitted = await auditRoutineSkip(
        r,
        "audience_floor",
        {
          floor: disclosure.floor,
          event: ev.event,
          ...(ev.action ? { action: ev.action } : {}),
          note: "the read grant allows this content but the reporting room's live audience floor does not",
        },
        auditDeps,
      );
      if (emitted) await announceFireWithheld(r.id, r.surfaceKey, dest.origin, deps.notice ?? {});
      continue;
    }
    let entityBlock: string | undefined;
    if (ev.pointer) {
      const h: HydrationOutcome = await hydratePointer(ev.pointer, memo, deps.hydrate ?? {});
      if (h.status === "forbidden") {
        drifted++;
        log(`event ${ev.summary} matched ${r.id} but hydrating ${ev.pointer.platform} ${ev.pointer.id} was REFUSED by the vendor — grant drift, skipped (no strike)`);
        await auditRoutineSkip(
          r,
          "grant_drift",
          {
            platform: ev.pointer.platform,
            entity: ev.pointer.id,
            event: ev.event,
            ...(ev.occurredAt ? { occurredAt: ev.occurredAt } : {}),
            note: "our read grant allows this scope but the vendor refused the fetch — access changed after the grant was written",
          },
          auditDeps,
        );
        continue;
      }
      if (h.status === "error") {
        log(`event ${ev.summary} matched ${r.id} but hydration failed: ${h.error}`);
        await loseFire(r, `hydration failed: ${h.error}`);
        continue;
      }
      if (h.status === "ok") {
        hydrated++;
        entityBlock = renderHydratedEntity(h.entity);
      }
    }
    const slackChannelId =
      r.surfaceKey.split("/")[0] === "slack" && typeof (dest.target as { channelId?: unknown }).channelId === "string"
        ? (dest.target as { channelId: string }).channelId
        : undefined;
    const internal = slackChannelId !== undefined && dest.mode === "channel" ? await confirmInternal(slackChannelId).catch(() => false) : false;
    const auth = {
      authenticator: ev.source,
      principalType: "service",
      principalId: `${ev.source}:webhook`,
      attributes: { ...routineFireAttributes(r, dest.attributes, dest.mode, internal), ...taintedFireAttrs(!ev.redacted) },
    };
    const message = eventPrompt(r, {
      summary: ev.summary,
      ...(ev.fields["url"] ? { url: ev.fields["url"] } : {}),
      ...(entityBlock ? { entity: entityBlock } : {}),
    });
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
    let lost = false;
    await deliver().catch(async (err: unknown) => {
      lost = true;
      log(`fire delivery failed for ${r.id} on ${r.surfaceKey}: ${String(err)}`);
      await loseFire(r, String(err));
    });
    fired++;
    if (lost) lostFires++;
  }
  if (matches.length > 0 || invalid > 0) {
    log(
      `event "${ev.summary}": ${matches.length} matched -> ${fired - lostFires} fired (${hydrated} hydrated), ${ungranted} ungranted, ` +
        `${withheld} audience-withheld, ${drifted} grant-drift, ${unwired} unwired, ${overCap} over-cap (cap ${cap}), ` +
        `${invalid} invalid-filter`,
    );
  }
  return {
    matched: matches.length,
    fired: fired - lostFires,
    skipped: ungranted + unwired + overCap + withheld + drifted + lostFires,
  };
}

export async function admitTrigger(d: TriggerDelivery, deps: TriggerAdmitDeps): Promise<TriggerReport> {
  const none = { matched: 0, fired: 0, skipped: 0 } as const;
  let rejection: string | undefined;
  const ev = normalizeDelivery(d, (reason) => {
    rejection = reason;
    log(`delivery not routable: ${reason}`);
  });
  if (!ev) return { accepted: false, reason: rejection ?? `source "${d.source}" does not model this event`, ...none };

  if (d.deliveryId) {
    const org = deps.org ?? deploymentOrg();
    const markSeen = deps.markSeen ?? liveMarkSeen;
    const atIso = (deps.now?.() ?? new Date()).toISOString();
    const first = await markSeen(org, deliveryDedupeKey(d.source, d.deliveryId), atIso, DELIVERY_DEDUPE_TTL_MS);
    if (!first) {
      log(`delivery ${d.deliveryId} already fanned out — replay dropped`);
      return { accepted: false, reason: "replay of an already-routed delivery", ...none };
    }
  }
  const tally = await fanOut(ev, deps);
  return { accepted: true, ...tally };
}
