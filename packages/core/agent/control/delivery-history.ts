import { appendAudit, readAudit, type AuditEntry, type AuditInput } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { getOperationalStore } from "../operational/provider.js";
import { describeReadableBy, scopeGrantsRead, type ReadableBy } from "../access/read-grant.js";
import type { EffectiveAccess } from "../access/resolver.js";
import { resolveAccessForPartition } from "../routines/event-authz.js";
import { FORENSIC_SCAN_LIMIT, FORENSIC_WINDOW_MS, ROUTINE_AUDIT } from "../routines/fire-audit.js";
import { isEventTrigger } from "../routines/event-match.js";
import { listAllRoutines } from "../routines/store.js";
import { hookReadableBy, type RuntimeWebhookHook } from "../webhooks/runtime-hook.js";
import { findWebhook, type WebhookHook } from "../webhooks/config.js";
import type { Partition } from "../memory/partition.js";
import type { Routine } from "../routines/routine.js";

export const WEBHOOK_HISTORY_READ = "webhook.history_read";

export const WEBHOOK_DELIVERY_ACTIONS = {
  fired: "webhook.fired",
  declined: "webhook.declined",
  rejected: "webhook.rejected",
} as const;

export const HISTORY_WINDOW_MS = FORENSIC_WINDOW_MS;

export const HISTORY_SCAN_LIMIT = FORENSIC_SCAN_LIMIT;

export const HISTORY_MAX_DELIVERIES = 25;

export const HISTORY_MAX_MISSES = 10;

export const HISTORY_DETAIL_MAX_CHARS = 300;

export type DeliveryVerification = "signed" | "previous-key" | "unverified" | "refused";

export interface DeliveryRecord {
  readonly at: string;
  readonly outcome: "fired" | "declined" | "rejected";
  readonly deliveryId: string | null;
  readonly bytes: number | null;
  readonly verification: DeliveryVerification;
  readonly status: number | null;
  readonly reason: string | null;
  readonly matched: number | null;
  readonly fired: number | null;
  readonly skipped: number | null;
  readonly standsFor: number;
}

export interface RoutineMiss {
  readonly at: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly standsFor: number;
}

export interface SubscriberOutcome {
  readonly routineId: string;
  readonly status: string;
  readonly surfaceKey: string;
  readonly fires: number;
  readonly lastFireAt: string | null;
  readonly misses: readonly RoutineMiss[];
}

export interface DeliveryHistory {
  readonly source: string;
  readonly hookClass: "config" | "runtime";
  readonly readableBy: string;
  readonly sinceIso: string;
  readonly deliveries: readonly DeliveryRecord[];
  readonly totals: {
    readonly accepted: number;
    readonly rejected: number;
    readonly matchedNothing: number;
  };
  readonly moreDeliveries: boolean;
  readonly subscribers: readonly SubscriberOutcome[];
  readonly throttled: boolean;
}

export type DeliveryHistoryResult =
  | { readonly ok: true; readonly history: DeliveryHistory }
  | { readonly ok: false; readonly reason: "unknown-hook" | "not-readable"; readonly message: string };

export interface DeliveryHistoryDeps {
  readonly configHooks?: () => readonly WebhookHook[];
  readonly runtimeHooks?: (org: string) => Promise<readonly RuntimeWebhookHook[]>;
  readonly routines?: () => Promise<Routine[]>;
  readonly read?: typeof readAudit;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly resolve?: (p: Partition) => EffectiveAccess;
  readonly now?: () => Date;
}

function cap(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, HISTORY_DETAIL_MAX_CHARS) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

interface ResolvedHook {
  readonly id: string;
  readonly source: string;
  readonly hookClass: "config" | "runtime";
  readonly readableBy: ReadableBy;
}

async function resolveHook(org: string, handle: string, deps: DeliveryHistoryDeps): Promise<ResolvedHook | undefined> {
  const configured = (deps.configHooks ?? (() => getConfig().loadWebhooks?.() ?? []))();
  const cfg = findWebhook(configured, handle);
  if (cfg) return { id: cfg.id, source: cfg.id, hookClass: "config", readableBy: cfg.readableBy };
  const runtime = await (deps.runtimeHooks ?? ((o: string) => getOperationalStore().listWebhookHooks(o)))(org);
  const row = runtime.find((h) => h.source === handle);
  if (!row) return undefined;
  return { id: row.id, source: row.source, hookClass: "runtime", readableBy: hookReadableBy(row) };
}

async function scan(deps: DeliveryHistoryDeps, org: string, action: string, since: string): Promise<readonly AuditEntry[]> {
  return (deps.read ?? readAudit)({ org, action, since, limit: HISTORY_SCAN_LIMIT });
}

function acceptedRecord(row: AuditEntry, outcome: "fired" | "declined"): DeliveryRecord {
  const d = row.detail ?? {};
  const verification: DeliveryVerification = d["unverified"] === true ? "unverified" : d["previousKey"] === true ? "previous-key" : "signed";
  return {
    at: row.ts,
    outcome,
    deliveryId: cap(d["deliveryId"]),
    bytes: num(d["bytes"]),
    verification,
    status: null,
    reason: cap(d["routingReason"]) ?? cap(d["reason"]),
    matched: num(d["matched"]),
    fired: num(d["fired"]),
    skipped: num(d["skipped"]),
    standsFor: 0,
  };
}

function rejectedRecord(row: AuditEntry): DeliveryRecord {
  const d = row.detail ?? {};
  return {
    at: row.ts,
    outcome: "rejected",
    deliveryId: null,
    bytes: null,
    verification: "refused",
    status: num(d["status"]),
    reason: cap(d["reason"]),
    matched: null,
    fired: null,
    skipped: null,
    standsFor: count(d["suppressed"]),
  };
}

export async function readDeliveryHistory(
  request: { readonly partition: Partition; readonly source: string },
  deps: DeliveryHistoryDeps = {},
): Promise<DeliveryHistoryResult> {
  const org = request.partition.org;
  const hook = await resolveHook(org, request.source, deps);
  if (!hook) {
    return {
      ok: false,
      reason: "unknown-hook",
      message: `no inbound webhook named "${request.source.slice(0, 80)}" exists for this org — check the name with list_webhooks.`,
    };
  }

  const grantText = describeReadableBy(hook.readableBy);
  let granted: boolean;
  try {
    const access = (deps.resolve ?? resolveAccessForPartition)(request.partition);
    granted = scopeGrantsRead(hook.readableBy, access);
  } catch {
    granted = false;
  }

  const now = deps.now?.() ?? new Date();
  const audit = deps.audit ?? appendAudit;
  await audit({
    org,
    platform: request.partition.platform,
    workspace: request.partition.workspace,
    surface: request.partition.surface,
    action: WEBHOOK_HISTORY_READ,
    detail: {
      hookId: hook.id,
      source: hook.source,
      hookClass: hook.hookClass,
      granted,
      readableBy: grantText,
    },
  }).catch(() => undefined);

  if (!granted) {
    return {
      ok: false,
      reason: "not-readable",
      message:
        `the "${hook.source}" hook's events are readable by: ${grantText}. This channel's domain is not among them, ` +
        "so its delivery history cannot be read from here (and no routine here could be fired by it either — it is the same grant).",
    };
  }

  const sinceIso = new Date(now.getTime() - HISTORY_WINDOW_MS).toISOString();
  const [firedRows, declinedRows, rejectedRows] = await Promise.all([
    scan(deps, org, WEBHOOK_DELIVERY_ACTIONS.fired, sinceIso),
    scan(deps, org, WEBHOOK_DELIVERY_ACTIONS.declined, sinceIso),
    scan(deps, org, WEBHOOK_DELIVERY_ACTIONS.rejected, sinceIso),
  ]);

  const mine = (rows: readonly AuditEntry[]): AuditEntry[] => rows.filter((r) => r.detail?.["hookId"] === hook.id);
  const accepted = [
    ...mine(firedRows).map((r) => acceptedRecord(r, "fired")),
    ...mine(declinedRows).map((r) => acceptedRecord(r, "declined")),
  ];
  const rejected = mine(rejectedRows).map(rejectedRecord);
  const deliveries = [...accepted, ...rejected].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const all = await (deps.routines ?? listAllRoutines)();
  const subscribed = all.filter((r) => r.org === org && isEventTrigger(r.trigger) && r.trigger.source === hook.source);
  const ids = new Set(subscribed.map((r) => r.id));

  const [fireRows, skipRows, lostRows] =
    ids.size === 0
      ? [[], [], []]
      : await Promise.all([
          scan(deps, org, ROUTINE_AUDIT.fire, sinceIso),
          scan(deps, org, ROUTINE_AUDIT.skip, sinceIso),
          scan(deps, org, ROUTINE_AUDIT.fireLost, sinceIso),
        ]);
  const forRoutine = (rows: readonly AuditEntry[], id: string): AuditEntry[] => rows.filter((r) => r.detail?.["routineId"] === id);

  const subscribers: SubscriberOutcome[] = subscribed.map((r) => {
    const fires = forRoutine(fireRows, r.id);
    const misses: RoutineMiss[] = [
      ...forRoutine(skipRows, r.id).map((row) => {
        const d = row.detail ?? {};
        const reason = typeof d["reason"] === "string" ? d["reason"] : "unknown";
        const detail = cap(d["why"]) ?? cap(d["grant"]) ?? cap(d["partition"]) ?? cap(d["floor"]) ?? cap(d["note"]);
        return { at: row.ts, reason, detail, standsFor: count(d["suppressed"]) };
      }),
      ...forRoutine(lostRows, r.id).map((row) => ({
        at: row.ts,
        reason: "fire_lost",
        detail: cap(row.detail?.["error"]),
        standsFor: 0,
      })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, HISTORY_MAX_MISSES);
    return {
      routineId: r.id,
      status: r.status,
      surfaceKey: r.surfaceKey,
      fires: fires.length,
      lastFireAt: fires[0]?.ts ?? null,
      misses,
    };
  });

  const page = deliveries.slice(0, HISTORY_MAX_DELIVERIES);
  const throttled =
    page.some((d) => d.standsFor > 0) || subscribers.some((s) => s.misses.some((m) => m.standsFor > 0));
  return {
    ok: true,
    history: {
      source: hook.source,
      hookClass: hook.hookClass,
      readableBy: grantText,
      sinceIso,
      deliveries: page,
      totals: {
        accepted: accepted.length,
        rejected: rejected.length,
        matchedNothing: accepted.filter((d) => d.matched === 0).length,
      },
      moreDeliveries: deliveries.length > page.length,
      subscribers,
      throttled,
    },
  };
}

export function renderDeliveryHistory(h: DeliveryHistory): string {
  const lines: string[] = [];
  lines.push(
    `webhook "${h.source}" (${h.hookClass}-declared) — deliveries since ${h.sinceIso}`,
    `readable by: ${h.readableBy}`,
    `${h.totals.accepted} accepted, ${h.totals.rejected} rejected at the door, ${h.totals.matchedNothing} accepted but matched no routine`,
    "",
  );
  if (h.deliveries.length === 0) {
    lines.push("No deliveries at all in the window — the sender has not reached this endpoint. Nothing downstream can be wrong yet.");
  } else {
    lines.push(`deliveries (newest first${h.moreDeliveries ? `, showing ${h.deliveries.length}` : ""}):`);
    for (const d of h.deliveries) {
      const parts = [
        d.at,
        d.outcome.toUpperCase(),
        d.status !== null ? `HTTP ${d.status}` : "",
        d.verification,
        d.bytes !== null ? `${d.bytes}B` : "",
        d.deliveryId ? `id=${d.deliveryId}` : "",
        d.matched !== null ? `matched ${d.matched} -> fired ${d.fired}, skipped ${d.skipped}` : "",
        d.reason ? `(${d.reason})` : "",
        d.standsFor > 0 ? `[+${d.standsFor} more like this, throttled]` : "",
      ].filter((s) => s.length > 0);
      lines.push(`  ${parts.join(" | ")}`);
    }
  }
  lines.push("");
  if (h.subscribers.length === 0) {
    lines.push("No event routine subscribes to this hook, so an accepted delivery has nothing to fire. Create one with create_routine.");
  } else {
    lines.push("subscribed routines:");
    for (const s of h.subscribers) {
      lines.push(`  ${s.routineId} [${s.status}] on ${s.surfaceKey} — ${s.fires} fire(s)${s.lastFireAt ? `, last ${s.lastFireAt}` : ""}`);
      if (s.misses.length === 0 && s.fires === 0) lines.push("    no fires and no recorded misses — its filter has not matched anything.");
      for (const m of s.misses) {
        lines.push(`    MISS ${m.at} ${m.reason}${m.detail ? `: ${m.detail}` : ""}${m.standsFor > 0 ? ` [+${m.standsFor} suppressed]` : ""}`);
      }
    }
  }
  if (h.throttled) {
    lines.push(
      "",
      "NOTE: miss and rejection rows are rate-limited (one per routine+reason per hour, one per rejection identity per minute) " +
        "and carry the count they stand in for. The ABSENCE of a row for a given delivery is not proof that delivery was fine.",
    );
  }
  return lines.join("\n");
}

export function historyOrg(): string {
  return deploymentOrg();
}
