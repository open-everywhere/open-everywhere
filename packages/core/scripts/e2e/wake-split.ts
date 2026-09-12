import { splitWakeLatency, renderWakeSplit, WAKE_INGRESS_ACTION, WAKE_TURN_START_ACTION, type WakeSplit, type VendorEventSource } from "../../agent/channels/wake-timing.js";
import type { AuditQueryOpts, AuditWireEntry } from "./audit-read.js";

export const IN_TURN_BAND_MAX_MS = 7_000;

export interface WakeSplitReading {
  readonly wakeId: string;
  readonly split: WakeSplit;
  readonly vendorSource?: VendorEventSource;
  readonly line: string;
}

function detail(row: AuditWireEntry | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function at(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export async function readWakeSplits(
  auditRead: (opts: AuditQueryOpts) => Promise<readonly AuditWireEntry[]>,
  opts: {
    readonly sinceIso: string;
    readonly untilIso?: string;
    readonly platform?: string;
    readonly bandMaxMs?: number;
    readonly labelPrefix?: string;
  },
): Promise<readonly WakeSplitReading[]> {
  const band = opts.bandMaxMs ?? IN_TURN_BAND_MAX_MS;
  let rows: AuditWireEntry[];
  try {
    const pages = await Promise.all(
      [WAKE_INGRESS_ACTION, WAKE_TURN_START_ACTION, "reply.post"].map((action) =>
        auditRead({ sinceIso: opts.sinceIso, actions: [action], ...(opts.platform ? { platform: opts.platform } : {}), limit: 500 }),
      ),
    );
    rows = pages.flatMap((p) => [...p]);
  } catch {
    return [];
  }
  const ordered = [...rows].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const untilMs = at(opts.untilIso);
  const turnStarts = new Map<string, AuditWireEntry>();
  const replies = new Map<string, AuditWireEntry>();
  for (const r of ordered) {
    const wakeId = detail(r).wakeId;
    if (typeof wakeId !== "string") continue;
    if (r.action === WAKE_TURN_START_ACTION && !turnStarts.has(wakeId)) turnStarts.set(wakeId, r);
    if (r.action === "reply.post" && !replies.has(wakeId)) replies.set(wakeId, r);
  }
  const out: WakeSplitReading[] = [];
  const seen = new Set<string>();
  for (const row of ordered) {
    if (row.action !== WAKE_INGRESS_ACTION) continue;
    const d = detail(row);
    const wakeId = d.wakeId;
    if (typeof wakeId !== "string" || seen.has(wakeId)) continue;
    const ingressMs = at(d.ingressTs) ?? at(row.ts);
    if (ingressMs === undefined) continue;
    if (untilMs !== undefined && ingressMs >= untilMs) continue;
    const replyMs = at(replies.get(wakeId)?.ts);
    if (replyMs === undefined) continue;
    const turnStartMs = at(detail(turnStarts.get(wakeId)).turnStartTs);
    const vendorMs = at(d.vendorTs);
    const split = splitWakeLatency(
      { ...(vendorMs === undefined ? {} : { vendorMs }), ingressMs, ...(turnStartMs === undefined ? {} : { turnStartMs }), replyMs },
      band,
    );
    const vendorSource = typeof d.vendorTsSource === "string" ? (d.vendorTsSource as VendorEventSource) : undefined;
    seen.add(wakeId);
    out.push({
      wakeId,
      split,
      ...(vendorSource ? { vendorSource } : {}),
      line: renderWakeSplit(`${opts.labelPrefix ?? "wake"} ${wakeId.slice(0, 8)}`, split, band, vendorSource),
    });
  }
  return out;
}

export function summariseWakeSplits(readings: readonly WakeSplitReading[]): string {
  if (readings.length === 0) return "latency split: no wake was measurable (no anchor rows joined to a reply) — nothing is claimed about this leg's seconds";
  const split = readings.filter((r) => r.split.worst !== "unsplit");
  const overBand = split.filter((r) => r.split.inBand === false).length;
  const counts = new Map<string, number>();
  for (const r of split) counts.set(r.split.worst, (counts.get(r.split.worst) ?? 0) + 1);
  counts.delete("none");
  const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return (
    `latency split: ${readings.length} wake(s) measured, ${split.length} with a turn-start anchor · ` +
    `${overBand} over the in-turn band · ` +
    (worst ? `excess most often carried by: ${worst[0]} (${worst[1]} of ${split.length})` : "no segment was over the band") +
    " · pre-turn segments are ENVIRONMENTAL and are never a verdict on this tree"
  );
}
