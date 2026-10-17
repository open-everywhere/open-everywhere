import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { DEFAULT_WATCH_DIAL, MAX_DAMPENING, clampDampening, parseWatchDial, type WatchDial } from "./dial.js";
import type { WatchSilenceReason } from "./judge.js";

export type WatchResponse = "useful" | "dismissed";

export interface WatchNudgeRecord {
  readonly fingerprint: string;
  readonly kind: string;
  readonly summary: string;
  readonly at: string;
  readonly response?: WatchResponse;
}

export type WatchProposalOutcome = "accepted" | "declined";

export interface WatchProposalRecord {
  readonly fingerprint: string;
  readonly summary: string;
  readonly at: string;
  readonly outcome?: WatchProposalOutcome;
  readonly decidedAt?: string;
}

export type WatchDialSource = "default" | "command" | "app-home";

export interface PersonalWatchState {
  readonly dial: WatchDial;
  readonly dialSource: WatchDialSource;
  readonly dialSetAt?: string;
  readonly dampening: number;
  readonly enrolledAt: string;
  readonly lastCheckAt?: string;
  readonly nextCheckAt?: string;
  readonly nudges: readonly WatchNudgeRecord[];
  readonly told: readonly string[];
  readonly silenced: Readonly<Record<string, WatchSilenceReason>>;
  readonly lastAskedAt?: string;
  readonly nudgesSinceAsk: number;
  readonly proposals: readonly WatchProposalRecord[];
  readonly lastDiscoveryAt?: string;
}

export const NUDGE_LOG_MAX = 20;
export const TOLD_MAX = 200;
export const SILENCED_MAX = 200;
export const PROPOSAL_LOG_MAX = 100;

export function freshWatchState(at: string): PersonalWatchState {
  return { dial: DEFAULT_WATCH_DIAL, dialSource: "default", dampening: 0, enrolledAt: at, nudges: [], told: [], silenced: {}, nudgesSinceAsk: 0, proposals: [] };
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function parseWatchState(json: string): PersonalWatchState {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const dial = parseWatchDial(raw["dial"]) ?? "none";
  const source = raw["dialSource"] === "command" || raw["dialSource"] === "app-home" ? raw["dialSource"] : "default";
  const dampening = typeof raw["dampening"] === "number" ? clampDampening(raw["dampening"]) : MAX_DAMPENING;
  const nudges = (Array.isArray(raw["nudges"]) ? raw["nudges"] : [])
    .map((n): WatchNudgeRecord | undefined => {
      const o = n as Record<string, unknown>;
      const fingerprint = strOrUndef(o?.["fingerprint"]);
      const at = strOrUndef(o?.["at"]);
      if (!fingerprint || !at) return undefined;
      const response = o["response"] === "useful" || o["response"] === "dismissed" ? o["response"] : undefined;
      return { fingerprint, kind: strOrUndef(o["kind"]) ?? "unknown", summary: strOrUndef(o["summary"]) ?? "", at, ...(response ? { response } : {}) };
    })
    .filter((n): n is WatchNudgeRecord => n !== undefined);
  const proposals = (Array.isArray(raw["proposals"]) ? raw["proposals"] : [])
    .map((p): WatchProposalRecord | undefined => {
      const o = p as Record<string, unknown>;
      const fingerprint = strOrUndef(o?.["fingerprint"]);
      const at = strOrUndef(o?.["at"]);
      if (!fingerprint || !at) return undefined;
      const outcome = o["outcome"] === "accepted" || o["outcome"] === "declined" ? o["outcome"] : undefined;
      const decidedAt = strOrUndef(o["decidedAt"]);
      return { fingerprint, summary: strOrUndef(o["summary"]) ?? "", at, ...(outcome ? { outcome } : {}), ...(decidedAt ? { decidedAt } : {}) };
    })
    .filter((p): p is WatchProposalRecord => p !== undefined);
  const told = (Array.isArray(raw["told"]) ? raw["told"] : []).filter((t): t is string => typeof t === "string");
  const silencedRaw = typeof raw["silenced"] === "object" && raw["silenced"] !== null ? (raw["silenced"] as Record<string, unknown>) : {};
  const silenced: Record<string, WatchSilenceReason> = {};
  for (const [k, v] of Object.entries(silencedRaw)) if (typeof v === "string") silenced[k] = v as WatchSilenceReason;
  return {
    dial,
    dialSource: source,
    ...(strOrUndef(raw["dialSetAt"]) ? { dialSetAt: strOrUndef(raw["dialSetAt"])! } : {}),
    dampening,
    enrolledAt: strOrUndef(raw["enrolledAt"]) ?? new Date(0).toISOString(),
    ...(strOrUndef(raw["lastCheckAt"]) ? { lastCheckAt: strOrUndef(raw["lastCheckAt"])! } : {}),
    ...(strOrUndef(raw["nextCheckAt"]) ? { nextCheckAt: strOrUndef(raw["nextCheckAt"])! } : {}),
    nudges,
    told,
    silenced,
    ...(strOrUndef(raw["lastAskedAt"]) ? { lastAskedAt: strOrUndef(raw["lastAskedAt"])! } : {}),
    nudgesSinceAsk: typeof raw["nudgesSinceAsk"] === "number" && raw["nudgesSinceAsk"] >= 0 ? Math.floor(raw["nudgesSinceAsk"]) : 0,
    proposals,
    ...(strOrUndef(raw["lastDiscoveryAt"]) ? { lastDiscoveryAt: strOrUndef(raw["lastDiscoveryAt"])! } : {}),
  };
}

export function capWatchState(s: PersonalWatchState): PersonalWatchState {
  const silencedKeys = Object.keys(s.silenced);
  const silenced =
    silencedKeys.length <= SILENCED_MAX ? s.silenced : Object.fromEntries(silencedKeys.slice(-SILENCED_MAX).map((k) => [k, s.silenced[k]!] as const));
  return { ...s, nudges: s.nudges.slice(-NUDGE_LOG_MAX), told: s.told.slice(-TOLD_MAX), silenced, proposals: s.proposals.slice(-PROPOSAL_LOG_MAX) };
}

export interface PersonalWatchRead {
  readonly state: PersonalWatchState | undefined;
  readonly version: number | null;
  readonly readable: boolean;
}

export async function readPersonalWatch(org: string, principalKey: string): Promise<PersonalWatchRead> {
  try {
    const row = await getOperationalStore().getPersonalWatch(org, principalKey);
    if (!row) return { state: undefined, version: null, readable: true };
    return { state: parseWatchState(row.stateJson), version: row.version, readable: true };
  } catch (err) {
    console.warn(`[open-everywhere:personal-watch] read failed (${principalKey}): ${String(err)} — the watch stays silent for this person`);
    return { state: undefined, version: null, readable: false };
  }
}

export async function updatePersonalWatch(
  org: string,
  principalKey: string,
  mutate: (current: PersonalWatchState, existed: boolean) => PersonalWatchState | undefined,
  at = new Date().toISOString(),
): Promise<PersonalWatchState | undefined> {
  const store = getOperationalStore();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await store.getPersonalWatch(org, principalKey);
    const current = row ? parseWatchState(row.stateJson) : freshWatchState(at);
    const next = mutate(current, row !== null);
    if (next === undefined) return undefined;
    const capped = capWatchState(next);
    const written = await store.casPersonalWatch(org, principalKey, JSON.stringify(capped), at, row ? row.version : null);
    if (written !== null) return capped;
  }
  throw new Error(`the watch row for ${principalKey} changed under three writes in a row`);
}

export async function enrollPersonalWatch(org: string, principalKey: string, at = new Date().toISOString()): Promise<"enrolled" | "already" | "failed"> {
  try {
    let enrolled = false;
    await updatePersonalWatch(
      org,
      principalKey,
      (current, existed) => {
        if (existed) return undefined;
        enrolled = true;
        return current;
      },
      at,
    );
    return enrolled ? "enrolled" : "already";
  } catch (err) {
    console.warn(`[open-everywhere:personal-watch] enrolment failed (${principalKey}): ${String(err)}`);
    return "failed";
  }
}

export interface PersonalWatchWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly principalKey: string;
}

export async function setPersonalWatchDial(
  where: PersonalWatchWhere,
  dial: WatchDial,
  via: Exclude<WatchDialSource, "default">,
  at = new Date().toISOString(),
  opts: { readonly existingOnly?: boolean } = {},
): Promise<{ readonly previous: WatchDial; readonly changed: boolean; readonly written: boolean }> {
  let previous: WatchDial = DEFAULT_WATCH_DIAL;
  let changed = false;
  let written = false;
  await updatePersonalWatch(
    where.org,
    where.principalKey,
    (current, existed) => {
      if (opts.existingOnly === true && !existed) return undefined;
      written = true;
      previous = current.dial;
      changed = current.dial !== dial;
      const { nextCheckAt: _drop, ...rest } = current;
      return { ...rest, dial, dialSource: via, dialSetAt: at };
    },
    at,
  );
  if (!written) return { previous, changed, written };
  await appendAudit({
    org: where.org,
    platform: where.platform,
    workspace: where.workspace,
    surface: where.surface,
    principalId: where.principalKey,
    action: "personal_watch.dial.set",
    detail: { dial, previous, via },
  }).catch(() => undefined);
  return { previous, changed, written };
}

export async function recordPersonalWatchResponse(
  where: PersonalWatchWhere,
  fingerprint: string,
  response: WatchResponse,
  via: "app-home" | "command",
  at = new Date().toISOString(),
): Promise<{ readonly outcome: "recorded" | "unchanged" | "unknown"; readonly dampening: number }> {
  let outcome = "unknown" as "recorded" | "unchanged" | "unknown";
  let dampening = 0;
  await updatePersonalWatch(
    where.org,
    where.principalKey,
    (current, existed) => {
      dampening = current.dampening;
      const i = existed ? current.nudges.findIndex((n) => n.fingerprint === fingerprint) : -1;
      if (i < 0) return undefined;
      const prior = current.nudges[i]!.response;
      if (prior === response) {
        outcome = "unchanged";
        return undefined;
      }
      const undo = prior === "dismissed" ? -1 : prior === "useful" ? 1 : 0;
      const step = response === "dismissed" ? 1 : -1;
      dampening = clampDampening(current.dampening + undo + step);
      const nudges = current.nudges.map((n, j) => (j === i ? { ...n, response } : n));
      outcome = "recorded";
      return { ...current, nudges, dampening };
    },
    at,
  );
  if (outcome === "recorded") {
    await appendAudit({
      org: where.org,
      platform: where.platform,
      workspace: where.workspace,
      surface: where.surface,
      principalId: where.principalKey,
      action: "personal_watch.response",
      detail: { response, dampening, via, fingerprint },
    }).catch(() => undefined);
  }
  return { outcome, dampening };
}

export async function recordProposalOutcome(org: string, principalKey: string, fingerprint: string, outcome: WatchProposalOutcome, at = new Date().toISOString()): Promise<"recorded" | "unchanged" | "unknown"> {
  let result = "unknown" as "recorded" | "unchanged" | "unknown";
  await updatePersonalWatch(
    org,
    principalKey,
    (current, existed) => {
      const i = existed ? current.proposals.findIndex((p) => p.fingerprint === fingerprint) : -1;
      if (i < 0) return undefined;
      if (current.proposals[i]!.outcome !== undefined) {
        result = "unchanged";
        return undefined;
      }
      result = "recorded";
      return { ...current, proposals: current.proposals.map((p, j) => (j === i ? { ...p, outcome, decidedAt: at } : p)) };
    },
    at,
  );
  return result;
}
