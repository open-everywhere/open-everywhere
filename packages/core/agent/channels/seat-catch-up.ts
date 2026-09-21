import { fetchedBackscroll, type BackscrollTrustFor, type NormalizedMessage } from "./backscroll-window.js";
import { admissionFunction, type SeatAdmissionFn } from "./seat-admission.js";
import type { WakeMessageInput } from "./wake-envelope.js";
import { appendAudit, type AuditInput } from "../audit/audit.js";
import { deploymentOrg } from "../identity/deployment-identity.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { admissionNameFor } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { getSettings } from "../settings/settings.js";
import { e2eDriverPrincipals, isE2eDriver } from "../testing/driver-allowlist.js";

export interface SeatCatchUpRequest {
  readonly container: string;
  readonly threadRoot?: string;
  readonly threadAnchor?: string;
  readonly sinceMs: number;
  readonly untilMs?: number;
  readonly excludeId?: string;
  readonly channelKey?: string;
  readonly surfaceInternal?: boolean;
}

export type SeatCatchUpFetch = (req: SeatCatchUpRequest) => Promise<readonly NormalizedMessage[]>;

export interface SeatCatchUpDeclaration {
  readonly timestampPrecisionMs?: number;
}

export const DEFAULT_TIMESTAMP_PRECISION_MS = 1;

interface SeatCatchUpRegistration {
  readonly fetch: SeatCatchUpFetch;
  readonly timestampPrecisionMs: number;
}

const FETCHES = processRegistryMap<SeatCatchUpRegistration>("seat-catch-up.v2");

export function registerSeatCatchUp(platform: string, fetch: SeatCatchUpFetch, declaration: SeatCatchUpDeclaration = {}): void {
  if (!admitProviderRegistration(platform, "seat-catch-up")) return;
  const declared = declaration.timestampPrecisionMs;
  const timestampPrecisionMs = typeof declared === "number" && Number.isInteger(declared) && declared >= 1 ? declared : DEFAULT_TIMESTAMP_PRECISION_MS;
  FETCHES.set(platform, { fetch, timestampPrecisionMs });
}

export function seatCatchUpFetchFor(platform: string): SeatCatchUpFetch | undefined {
  return FETCHES.get(platform)?.fetch;
}

export function seatCatchUpPrecisionFor(platform: string): number {
  return FETCHES.get(platform)?.timestampPrecisionMs ?? DEFAULT_TIMESTAMP_PRECISION_MS;
}

export function _resetSeatCatchUp(platform: string): void {
  FETCHES.delete(platform);
}

export function seatCatchUpBounds(sinceMs: number, untilMs: number | undefined, precisionMs: number): { readonly sinceMs: number; readonly untilMs: number | undefined } {
  const unit = Number.isInteger(precisionMs) && precisionMs >= 1 ? precisionMs : DEFAULT_TIMESTAMP_PRECISION_MS;
  const floorTo = (t: number): number => (Number.isFinite(t) ? Math.floor(t / unit) * unit : t);
  return {
    sinceMs: floorTo(sinceMs),
    untilMs: untilMs === undefined || !Number.isFinite(untilMs) ? untilMs : floorTo(untilMs) + unit,
  };
}

const CATCH_UP_UNAVAILABLE_NOTE =
  "This surface cannot read its own history between wakes, so nothing below is a catch-up: what the room said since your last wake is NOT shown, and an absence of messages here does not mean the room was quiet.";

export function catchUpUnavailableReason(platform: string): string {
  return `${platform}: ${CATCH_UP_UNAVAILABLE_NOTE}`;
}

export function seatAdmissionFor(channelKey: string | undefined): SeatAdmissionFn {
  try {
    const domains = getConfig().loadDomains();
    const base = admissionFunction(channelKey ? admissionNameFor(channelKey, domains) : undefined);
    if (channelKey === undefined) return base;
    return withE2eDriverAdmission(base, surfaceOfChannelKey(channelKey), workspaceOfChannelKey(channelKey));
  } catch {
    return admissionFunction(undefined);
  }
}

function surfaceOfChannelKey(channelKey: string): string {
  const slash = channelKey.indexOf("/");
  return slash === -1 ? channelKey : channelKey.slice(0, slash);
}

function workspaceOfChannelKey(channelKey: string): string | undefined {
  const workspace = channelKey.split("/")[1];
  return workspace === undefined || workspace === "" ? undefined : workspace;
}

export function withE2eDriverAdmission(base: SeatAdmissionFn, surface: string, workspace: string | undefined): SeatAdmissionFn {
  const drivers = getSettings().wake.e2eDrivers;
  if (e2eDriverPrincipals(drivers, surface).length === 0) return base;
  return (c) => base(c) || (c.sender === "bot" && isE2eDriver(drivers, surface, workspace, c.authorId));
}

export interface SeatCatchUpResult {
  readonly messages: readonly WakeMessageInput[];
  readonly unavailable?: string;
}

export interface SeatCatchUpOpts {
  readonly trustFor?: BackscrollTrustFor;
  readonly admit?: SeatAdmissionFn;
  readonly capTokens?: number;
  readonly audit?: (entry: AuditInput) => Promise<void>;
}

export const SEAT_CATCH_UP_ACTION = "seat.catch_up";

export type SeatCatchUpOutcome = "read" | "empty" | "unavailable" | "failed";

export function seatCatchUpScopeFromChannelKey(platform: string, channelKey: string | undefined): { workspace: string; surface: string } | undefined {
  if (!channelKey) return undefined;
  const parts = channelKey.split("/");
  if (parts.length !== 3 || parts[0] !== platform || !parts[1] || !parts[2]) return undefined;
  return { workspace: parts[1], surface: parts[2] };
}

function httpStatusOf(err: unknown): number | undefined {
  const m = /\(HTTP (\d{3})\)/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : undefined;
}

function errorNameOf(err: unknown): string {
  return err instanceof Error && typeof err.name === "string" && err.name.length > 0 ? err.name : "unknown";
}

export async function seatCatchUp(platform: string, req: SeatCatchUpRequest, opts: SeatCatchUpOpts = {}): Promise<SeatCatchUpResult> {
  const scope = seatCatchUpScopeFromChannelKey(platform, req.channelKey);
  const precisionMs = seatCatchUpPrecisionFor(platform);
  const bounds = seatCatchUpBounds(req.sinceMs, req.untilMs, precisionMs);
  const record = async (outcome: SeatCatchUpOutcome, raw: number, kept: number, extra: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    try {
      await (opts.audit ?? appendAudit)({
        org: deploymentOrg(),
        platform,
        workspace: scope?.workspace ?? "unknown",
        ...(scope ? { surface: scope.surface } : {}),
        action: SEAT_CATCH_UP_ACTION,
        detail: {
          outcome,
          raw,
          kept,
          container: req.container,
          ...(req.threadRoot === undefined ? {} : { threadRoot: req.threadRoot }),
          since: Number.isFinite(bounds.sinceMs) ? new Date(bounds.sinceMs).toISOString() : "unparsable",
          precisionMs,
          ...extra,
        },
      });
    } catch {
    }
  };

  const fetch = seatCatchUpFetchFor(platform);
  if (!fetch) {
    await record("unavailable", 0, 0, { reason: "no-registered-fetch" });
    return { messages: [], unavailable: catchUpUnavailableReason(platform) };
  }
  const boundedReq: SeatCatchUpRequest = { ...req, sinceMs: bounds.sinceMs, ...(bounds.untilMs === undefined ? {} : { untilMs: bounds.untilMs }) };
  let window: readonly NormalizedMessage[];
  try {
    window = await fetch(boundedReq);
  } catch (err) {
    const status = httpStatusOf(err);
    await record("failed", 0, 0, { reason: "fetch-threw", errorName: errorNameOf(err), ...(status === undefined ? {} : { httpStatus: status }) });
    return { messages: [] };
  }
  if (window.length === 0) {
    await record("empty", 0, 0, { reason: "fetch-returned-none" });
    return { messages: [] };
  }
  const bounded = window.filter((m) => m.ms >= bounds.sinceMs && (bounds.untilMs === undefined || m.ms < bounds.untilMs) && m.id !== req.excludeId);
  if (bounded.length === 0) {
    await record("empty", window.length, 0, { reason: "bounds-dropped-all" });
    return { messages: [] };
  }
  const messages = fetchedBackscroll(bounded, opts.capTokens, opts.trustFor, opts.admit ?? seatAdmissionFor(req.channelKey));
  if (messages.length === 0) {
    await record("empty", window.length, 0, { reason: "admission-dropped-all" });
    return { messages };
  }
  await record("read", window.length, messages.length);
  return { messages };
}
