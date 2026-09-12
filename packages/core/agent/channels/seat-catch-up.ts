import { fetchedBackscroll, type BackscrollTrustFor, type NormalizedMessage } from "./backscroll-window.js";
import { admissionFunction, type SeatAdmissionFn } from "./seat-admission.js";
import type { WakeMessageInput } from "./wake-envelope.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { admissionNameFor } from "../memory/domain.js";
import { getConfig } from "../access/config.js";

export interface SeatCatchUpRequest {
  readonly container: string;
  readonly threadRoot?: string;
  readonly sinceMs: number;
  readonly untilMs?: number;
  readonly excludeId?: string;
  readonly channelKey?: string;
  readonly surfaceInternal?: boolean;
}

export type SeatCatchUpFetch = (req: SeatCatchUpRequest) => Promise<readonly NormalizedMessage[]>;

const FETCHES = processRegistryMap<SeatCatchUpFetch>("seat-catch-up.v1");

export function registerSeatCatchUp(platform: string, fetch: SeatCatchUpFetch): void {
  if (!admitProviderRegistration(platform, "seat-catch-up")) return;
  FETCHES.set(platform, fetch);
}

export function seatCatchUpFetchFor(platform: string): SeatCatchUpFetch | undefined {
  return FETCHES.get(platform);
}

export function _resetSeatCatchUp(platform: string): void {
  FETCHES.delete(platform);
}

const CATCH_UP_UNAVAILABLE_NOTE =
  "This surface cannot read its own history between wakes, so nothing below is a catch-up: what the room said since your last wake is NOT shown, and an absence of messages here does not mean the room was quiet.";

export function catchUpUnavailableReason(platform: string): string {
  return `${platform}: ${CATCH_UP_UNAVAILABLE_NOTE}`;
}

export function seatAdmissionFor(channelKey: string | undefined): SeatAdmissionFn {
  try {
    return admissionFunction(channelKey ? admissionNameFor(channelKey, getConfig().loadDomains()) : undefined);
  } catch {
    return admissionFunction(undefined);
  }
}

export interface SeatCatchUpResult {
  readonly messages: readonly WakeMessageInput[];
  readonly unavailable?: string;
}

export interface SeatCatchUpOpts {
  readonly trustFor?: BackscrollTrustFor;
  readonly admit?: SeatAdmissionFn;
  readonly capTokens?: number;
}

export async function seatCatchUp(platform: string, req: SeatCatchUpRequest, opts: SeatCatchUpOpts = {}): Promise<SeatCatchUpResult> {
  const fetch = seatCatchUpFetchFor(platform);
  if (!fetch) return { messages: [], unavailable: catchUpUnavailableReason(platform) };
  let window: readonly NormalizedMessage[];
  try {
    window = await fetch(req);
  } catch {
    return { messages: [] };
  }
  if (window.length === 0) return { messages: [] };
  const bounded = window.filter((m) => m.ms >= req.sinceMs && (req.untilMs === undefined || m.ms < req.untilMs) && m.id !== req.excludeId);
  if (bounded.length === 0) return { messages: [] };
  return { messages: fetchedBackscroll(bounded, opts.capTokens, opts.trustFor, opts.admit) };
}
