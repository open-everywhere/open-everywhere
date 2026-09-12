export type VendorEventSource =
  | "slack-ts"
  | "discord-snowflake"
  | "vendor-time"
  | "receipt";

export interface VendorEventTime {
  readonly ms: number;
  readonly source: VendorEventSource;
}

const EARLIEST_USABLE_MS = 1_420_070_400_000;
const LATEST_USABLE_MS = 8_640_000_000_000_000;

function usable(ms: number, source: VendorEventSource): VendorEventTime | undefined {
  return Number.isFinite(ms) && ms >= EARLIEST_USABLE_MS && ms <= LATEST_USABLE_MS ? { ms: Math.round(ms), source } : undefined;
}

export function slackVendorEventTime(ts: string | undefined): VendorEventTime | undefined {
  if (!ts) return undefined;
  const [secs, micros = ""] = ts.split(".");
  const s = Number(secs);
  if (!Number.isFinite(s)) return undefined;
  const fraction = Number(`0.${micros.replace(/\D/g, "") || "0"}`);
  if (!Number.isFinite(fraction)) return undefined;
  return usable(s * 1000 + fraction * 1000, "slack-ts");
}

const DISCORD_EPOCH_MS = 1_420_070_400_000;

export function discordVendorEventTime(messageId: string | undefined): VendorEventTime | undefined {
  if (!messageId || !/^\d+$/.test(messageId)) return undefined;
  try {
    return usable(Number((BigInt(messageId) >> 22n) + BigInt(DISCORD_EPOCH_MS)), "discord-snowflake");
  } catch {
    return undefined;
  }
}

export function vendorInstantEventTime(iso: string | undefined): VendorEventTime | undefined {
  if (!iso) return undefined;
  return usable(Date.parse(iso), "vendor-time");
}

export function receiptEventTime(atMs: number): VendorEventTime | undefined {
  return usable(atMs, "receipt");
}

export function spreadVendorTs(vendor: VendorEventTime | undefined): { readonly vendorTs?: VendorEventTime } {
  return vendor ? { vendorTs: vendor } : {};
}

export const WAKE_INGRESS_ACTION = "wake.ingress";

export const WAKE_TURN_START_ACTION = "wake.turn_start";

export type WakeIngressDetail = {
  readonly wakeId: string;
  readonly deliveryId?: string;
  readonly surfaceKey: string;
  readonly vendorTs?: string;
  readonly vendorTsSource?: VendorEventSource;
  readonly ingressTs: string;
  readonly vendorToIngressMs?: number;
};

export function wakeIngressDetail(input: {
  readonly wakeId: string;
  readonly deliveryId?: string;
  readonly surfaceKey: string;
  readonly vendor?: VendorEventTime;
  readonly ingressMs: number;
}): WakeIngressDetail {
  const ingressTs = new Date(input.ingressMs).toISOString();
  return {
    wakeId: input.wakeId,
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    surfaceKey: input.surfaceKey,
    ...(input.vendor
      ? {
          vendorTs: new Date(input.vendor.ms).toISOString(),
          vendorTsSource: input.vendor.source,
          vendorToIngressMs: input.ingressMs - input.vendor.ms,
        }
      : {}),
    ingressTs,
  };
}

export type WakeTurnStartDetail = {
  readonly wakeId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly turnStartTs: string;
};

export interface WakeSplitInput {
  readonly vendorMs?: number;
  readonly ingressMs: number;
  readonly turnStartMs?: number;
  readonly replyMs: number;
}

export type WakeSplitSegment = "vendor-to-ingress" | "ingress-to-turn-start" | "pre-turn" | "in-turn" | "none" | "unsplit";

export interface WakeSplit {
  readonly vendorToIngressMs?: number;
  readonly ingressToTurnStartMs?: number;
  readonly preTurnMs?: number;
  readonly inTurnMs?: number;
  readonly totalMs: number;
  readonly inBand?: boolean;
  readonly worst: WakeSplitSegment;
}

export function splitWakeLatency(input: WakeSplitInput, bandMaxMs: number): WakeSplit {
  const { vendorMs, ingressMs, turnStartMs, replyMs } = input;
  const vendorToIngressMs = vendorMs === undefined ? undefined : ingressMs - vendorMs;
  const totalMs = replyMs - (vendorMs ?? ingressMs);
  if (turnStartMs === undefined) {
    return { ...(vendorToIngressMs === undefined ? {} : { vendorToIngressMs }), totalMs, worst: "unsplit" };
  }
  const ingressToTurnStartMs = turnStartMs - ingressMs;
  const preTurnMs = (vendorToIngressMs ?? 0) + ingressToTurnStartMs;
  const inTurnMs = replyMs - turnStartMs;
  const inTurnOver = inTurnMs - bandMaxMs;
  const worst: WakeSplitSegment =
    inTurnOver <= 0 && preTurnMs <= bandMaxMs
      ? "none"
      : inTurnOver > 0 && inTurnOver >= preTurnMs
      ? "in-turn"
      : vendorToIngressMs !== undefined && vendorToIngressMs > ingressToTurnStartMs
        ? "vendor-to-ingress"
        : ingressToTurnStartMs > 0
          ? "ingress-to-turn-start"
          : inTurnOver > 0
            ? "in-turn"
            : "pre-turn";
  return {
    ...(vendorToIngressMs === undefined ? {} : { vendorToIngressMs }),
    ingressToTurnStartMs,
    preTurnMs,
    inTurnMs,
    totalMs,
    inBand: inTurnMs <= bandMaxMs,
    worst,
  };
}

function secs(ms: number | undefined): string {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

export function renderWakeSplit(label: string, split: WakeSplit, bandMaxMs: number, vendorSource?: VendorEventSource): string {
  const vendor = split.vendorToIngressMs === undefined ? "vendor→ingress —" : `vendor→ingress ${secs(split.vendorToIngressMs)}${vendorSource === "receipt" ? " (receipt: a LOWER bound)" : ""}`;
  if (split.worst === "unsplit") {
    return `${label}: ${vendor} · NO turn-start row joined — the pre-turn and in-turn segments cannot be separated · total ${secs(split.totalMs)} · band applied to NOTHING`;
  }
  const verdict = split.inBand ? "IN BAND" : `OVER the ${secs(bandMaxMs)} band`;
  const attribution = split.worst === "none" ? "no segment is over the band" : `excess carried by: ${split.worst}`;
  return (
    `${label}: ${vendor} · ingress→turn-start ${secs(split.ingressToTurnStartMs)} · ` +
    `pre-turn ${secs(split.preTurnMs)} [ENVIRONMENTAL — not judged] · ` +
    `in-turn ${secs(split.inTurnMs)} [${verdict}] · total ${secs(split.totalMs)} · ${attribution}`
  );
}
