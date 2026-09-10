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
import { recheckFireCreator, type CreatorStandingCheck } from "./fire-creator.js";
import { routinePartition } from "./partition.js";
import { routineFireHalted } from "./fire-halt.js";
import { scopeOverBudget } from "../spend/check.js";
import { getSettings } from "../settings/settings.js";
import type { Trust } from "../identity/binding.js";
import { divertTriggeredFire, runFireSeatKey, type FireWindowDeps } from "./fire-window.js";
import { auditRoutineFireLost, auditRoutineSkip, type RoutineAuditDeps } from "./fire-audit.js";
import { foldRoutineOutcome } from "./outcome-fold.js";
import { eventPrompt } from "./events.js";
import { preFireFallback, runPreFire, type PreFireOutcome } from "./pre-fire.js";
import { normalizeDelivery, type NormalizedEvent, type StoredSubscription, type TriggerDelivery } from "./event-model.js";
import { evaluateSubscription, isEventTrigger, storedFilter } from "./event-match.js";
import { stampSubscriptionMatch, type MatchStampDeps } from "./match-stamp.js";
import { captureDocument } from "../webhooks/capture-window.js";
import { CAPTURE_MAX_DELIVERIES } from "../operational/store.js";
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

function eventMaxFanOut(): number {
  return getSettings().routines.eventMaxFanout;
}

export const DELIVERY_DEDUPE_TTL_MS = 10 * 60_000;

export const DELIVERY_ID_MAX_CHARS = 200;

export function deliveryDedupeKey(source: string, deliveryId: string): string {
  return `trigger:${source}:${deliveryId}`;
}

export interface TriggerAdmitDeps {
  readonly to: RouteHandlerArgs["to"];
  readonly org?: string;
  readonly listRoutines?: () => Promise<Routine[]>;
  readonly resolveTarget?: (r: Routine) => DispatchTarget | null;
  readonly confirmInternal?: (channelId: string) => Promise<boolean>;
  readonly confirmCreatorInternal?: CreatorStandingCheck;
  readonly markSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly now?: () => Date;
  readonly fireWindow?: FireWindowDeps;
  readonly grant?: EventGrantDeps;
  readonly hydrate?: HydrationDeps;
  readonly disclosure?: FireDisclosureDeps;
  readonly notice?: FireWithheldNoticeDeps;
  readonly matchStamp?: MatchStampDeps;
  readonly captureDelivery?: (...args: CaptureArgs) => Promise<boolean>;
}

export interface TriggerReport {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly deliveryId?: string;
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

function auditFilterText(t: StoredSubscription): string {
  const f = storedFilter(t);
  if (f.kind === "jq") return f.expression;
  return f.kind === "none" ? "(none)" : `(unreadable stored shape: ${f.keys.join(", ")})`;
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
  const stampDeps: MatchStampDeps = {
    ...(deps.markSeen ? { markSeen: deps.markSeen } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.matchStamp ?? {}),
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
    const verdict = await evaluateSubscription(r, ev);
    if ("invalid" in verdict) {
      invalid++;
      log(`event ${ev.summary} skipped ${r.id}: filter did not evaluate (${verdict.invalid})`);
      await auditRoutineSkip(
        r,
        "filter_invalid",
        {
          why: verdict.invalid,
          event: ev.event,
          ...(isEventTrigger(r.trigger) ? { filter: auditFilterText(r.trigger), source: r.trigger.source } : {}),
          note: "the subscription's filter could not be evaluated to a boolean, so the routine was skipped rather than fired",
        },
        auditDeps,
      );
      continue;
    }
    if (!verdict.match) continue;
    await stampSubscriptionMatch(r, stampDeps);
    matches.push(r);
  }
  const cap = eventMaxFanOut();
  const memo: HydrationMemo = newHydrationMemo();
  let fired = 0;
  let unwired = 0;
  let overCap = 0;
  let overBudget = 0;
  let halted = 0;
  let ungranted = 0;
  let drifted = 0;
  let gated = 0;
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
    const slackChannelId =
      r.surfaceKey.split("/")[0] === "slack" && typeof (dest.target as { channelId?: unknown }).channelId === "string"
        ? (dest.target as { channelId: string }).channelId
        : undefined;
    const internal = slackChannelId !== undefined && dest.mode === "channel" ? await confirmInternal(slackChannelId).catch(() => false) : false;
    const creatorInternal = await recheckFireCreator({
      createdBy: r.createdBy,
      platform: r.surfaceKey.split("/")[0],
      mode: dest.mode,
      workspaceId: r.surfaceKey.split("/")[1],
      ...(deps.confirmCreatorInternal ? { check: deps.confirmCreatorInternal } : {}),
    }).catch(() => undefined);
    const fireTrust: Trust = (dest.mode === "dm" ? creatorInternal === true : internal) ? "internal" : "external";
    if (await routineFireHalted(r, { event: ev.event, ...(ev.action ? { action: ev.action } : {}) }, { audit: auditDeps })) {
      halted++;
      log(`event ${ev.summary} matched ${r.id} but a break-glass halt is in force — SKIPPED (audited; an event has no "later")`);
      continue;
    }
    try {
      const verdict = await scopeOverBudget(routinePartition(r), dest.mode, (deps.now?.() ?? new Date()).toISOString(), fireTrust, r.createdBy);
      if (verdict.over) {
        overBudget++;
        log(`event ${ev.summary} matched ${r.id} but the scope is over budget (${verdict.reason ?? "cap reached"}) — SKIPPED (audited; an event has no "later")`);
        await auditRoutineSkip(
          r,
          "over_budget",
          {
            ...(verdict.reason ? { budgetReason: verdict.reason } : {}),
            event: ev.event,
            ...(ev.action ? { action: ev.action } : {}),
          },
          auditDeps,
        );
        continue;
      }
    } catch {
    }
    const pre = await runPreFire(r, (deps.now?.() ?? new Date()).toISOString()).catch((err: unknown): PreFireOutcome => preFireFallback(r, err));
    if (!pre.gate.fire) {
      gated++;
      log(`event ${ev.summary} matched ${r.id} but its condition gate said no — SKIPPED (audited): ${pre.gate.why}`);
      await auditRoutineSkip(
        r,
        "condition_gate",
        {
          ...(pre.gate.gate ? { gate: pre.gate.gate } : {}),
          gateReason: pre.gate.why,
          event: ev.event,
          ...(ev.action ? { action: ev.action } : {}),
        },
        auditDeps,
      );
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
    const fireWakeId = mintWakeId();
    const auth = {
      authenticator: ev.source,
      principalType: "service",
      principalId: `${ev.source}:webhook`,
      attributes: { ...routineFireAttributes(r, dest.attributes, dest.mode, internal, creatorInternal, fireWakeId), ...taintedFireAttrs(!ev.redacted || pre.tainted) },
    };
    const message = eventPrompt(
      r,
      {
        summary: ev.summary,
        ...(ev.fields["url"] ? { url: ev.fields["url"] } : {}),
        ...(entityBlock ? { entity: entityBlock } : {}),
      },
      pre.collected,
    );
    const deliver = async (): Promise<void> => {
      if (dest.origin) {
        const diverted = await divertTriggeredFire(
          deps.to,
          { message, surfaceKey: r.surfaceKey, origin: dest.origin, seatKey: runFireSeatKey(fireWakeId), auth, wakeId: fireWakeId },
          deps.fireWindow ?? {},
        );
        if (diverted) return;
      }
      await deps.to(dest.channel, dest.target).send(message, { auth });
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
        `${withheld} audience-withheld, ${overBudget} over-budget, ${halted} halted, ${gated} condition-gated, ${drifted} grant-drift, ${unwired} unwired, ${overCap} over-cap (cap ${cap}), ` +
        `${invalid} invalid-filter`,
    );
  }
  return {
    matched: matches.length,
    fired: fired - lostFires,
    skipped: ungranted + unwired + overCap + overBudget + halted + gated + withheld + drifted + lostFires,
  };
}

export async function admitTrigger(d: TriggerDelivery, deps: TriggerAdmitDeps): Promise<TriggerReport> {
  const id = d.deliveryId ? { deliveryId: d.deliveryId.slice(0, DELIVERY_ID_MAX_CHARS) } : {};
  const none = { ...id, matched: 0, fired: 0, skipped: 0 } as const;
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
  await captureIfArmed(d, ev, deps);

  const tally = await fanOut(ev, deps);
  return { accepted: true, ...id, ...tally };
}

async function captureIfArmed(d: TriggerDelivery, ev: NormalizedEvent, deps: TriggerAdmitDeps): Promise<void> {
  if (!d.captureUntil) return;
  const documentJson = captureDocument(ev);
  if (!documentJson) return;
  try {
    const org = deps.org ?? deploymentOrg();
    const at = (deps.now?.() ?? new Date()).toISOString();
    const capture = deps.captureDelivery ?? ((...a: CaptureArgs) => getOperationalStore().captureDelivery(...a));
    await capture(org, ev.source, documentJson, at, d.captureUntil, CAPTURE_MAX_DELIVERIES);
  } catch (err) {
    log(`capture window write failed for "${ev.source}": ${String(err)}`);
  }
}

type CaptureArgs = [org: string, source: string, documentJson: string, at: string, captureUntil: string, maxRows: number];
