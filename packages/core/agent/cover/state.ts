import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";

export interface CoverEntry {
  readonly wakeId: string;
  readonly at: string;
  readonly askerName?: string;
  readonly platform: string;
  readonly channelId: string;
  readonly surfaceKey: string;
  readonly roomPublic: boolean;
  readonly question: string;
  readonly answer?: string;
}

export interface CoverState {
  readonly on: boolean;
  readonly since?: string;
  readonly until?: string;
  readonly name?: string;
  readonly setAt: string;
  readonly entries: readonly CoverEntry[];
  readonly recapDue: boolean;
  readonly recapTries: number;
  readonly recapClaimAt?: string;
}

export const COVER_LOG_MAX = 25;
export const COVER_TEXT_MAX_CHARS = 280;
export const COVER_RECAP_MAX_TRIES = 3;

export function clipCoverText(text: string): string {
  const folded = text.replace(/\s+/g, " ").trim();
  return folded.length <= COVER_TEXT_MAX_CHARS ? folded : `${folded.slice(0, COVER_TEXT_MAX_CHARS - 1).trimEnd()}…`;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function freshCoverState(at: string): CoverState {
  return { on: false, setAt: at, entries: [], recapDue: false, recapTries: 0 };
}

export function parseCoverState(json: string): CoverState {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const entries = (Array.isArray(raw["entries"]) ? raw["entries"] : [])
    .map((e): CoverEntry | undefined => {
      const o = e as Record<string, unknown>;
      const wakeId = strOrUndef(o?.["wakeId"]);
      const at = strOrUndef(o?.["at"]);
      const platform = strOrUndef(o?.["platform"]);
      const channelId = strOrUndef(o?.["channelId"]);
      const surfaceKey = strOrUndef(o?.["surfaceKey"]);
      if (!wakeId || !at || !platform || !channelId || !surfaceKey) return undefined;
      const askerName = strOrUndef(o["askerName"]);
      const answer = strOrUndef(o["answer"]);
      return {
        wakeId,
        at,
        ...(askerName ? { askerName } : {}),
        platform,
        channelId,
        surfaceKey,
        roomPublic: o["roomPublic"] === true,
        question: strOrUndef(o["question"]) ?? "",
        ...(answer ? { answer } : {}),
      };
    })
    .filter((e): e is CoverEntry => e !== undefined);
  const since = strOrUndef(raw["since"]);
  const until = strOrUndef(raw["until"]);
  const name = strOrUndef(raw["name"]);
  const recapClaimAt = strOrUndef(raw["recapClaimAt"]);
  return {
    on: raw["on"] === true,
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(name ? { name } : {}),
    setAt: strOrUndef(raw["setAt"]) ?? new Date(0).toISOString(),
    entries,
    recapDue: raw["recapDue"] === true,
    recapTries: typeof raw["recapTries"] === "number" && raw["recapTries"] >= 0 ? Math.floor(raw["recapTries"]) : 0,
    ...(recapClaimAt ? { recapClaimAt } : {}),
  };
}

export function coverLive(s: CoverState | undefined, now: Date): boolean {
  if (!s?.on) return false;
  if (s.until !== undefined) {
    const end = Date.parse(s.until);
    if (!Number.isFinite(end) || end <= now.getTime()) return false;
  }
  return true;
}

export interface PersonalCoverRead {
  readonly state: CoverState | undefined;
  readonly readable: boolean;
}

export async function readPersonalCover(org: string, principalKey: string): Promise<PersonalCoverRead> {
  try {
    const row = await getOperationalStore().getPersonalCover(org, principalKey);
    if (!row) return { state: undefined, readable: true };
    return { state: parseCoverState(row.stateJson), readable: true };
  } catch (err) {
    console.warn(`[open-everywhere:cover] read failed (${principalKey}): ${String(err)} — no cover for this person`);
    return { state: undefined, readable: false };
  }
}

export async function updatePersonalCover(
  org: string,
  principalKey: string,
  mutate: (current: CoverState, existed: boolean) => CoverState | undefined,
  at = new Date().toISOString(),
): Promise<CoverState | undefined> {
  const store = getOperationalStore();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await store.getPersonalCover(org, principalKey);
    const current = row ? parseCoverState(row.stateJson) : freshCoverState(at);
    const next = mutate(current, row !== null);
    if (next === undefined) return undefined;
    const capped = { ...next, entries: next.entries.slice(-COVER_LOG_MAX) };
    const written = await store.casPersonalCover(org, principalKey, JSON.stringify(capped), at, row ? row.version : null);
    if (written !== null) return capped;
  }
  throw new Error(`the cover row for ${principalKey} changed under three writes in a row`);
}

export interface PersonalCoverWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly principalKey: string;
}

export const COVER_SET_ACTION = "cover.set";

export async function turnCoverOn(where: PersonalCoverWhere, opts: { readonly until?: string; readonly name?: string; readonly via: "command" }, at = new Date().toISOString()): Promise<{ readonly changed: boolean }> {
  let changed = false;
  await updatePersonalCover(
    where.org,
    where.principalKey,
    (current) => {
      const live = coverLive(current, new Date(at));
      changed = !live || current.until !== opts.until;
      const { until: _u, since: _s, recapClaimAt: _c, ...rest } = current;
      return {
        ...rest,
        on: true,
        since: live && current.since !== undefined ? current.since : at,
        ...(opts.until !== undefined ? { until: opts.until } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        setAt: at,
        recapDue: false,
        recapTries: 0,
      };
    },
    at,
  );
  await appendAudit({
    org: where.org,
    platform: where.platform,
    workspace: where.workspace,
    surface: where.surface,
    principalId: where.principalKey,
    action: COVER_SET_ACTION,
    detail: { on: true, until: opts.until ?? null, via: opts.via },
  }).catch(() => undefined);
  return { changed };
}

export async function turnCoverOff(where: PersonalCoverWhere, via: "command" | "end-date", at = new Date().toISOString()): Promise<{ readonly wasOn: boolean; readonly questions: number; readonly written: boolean }> {
  let wasOn = false;
  let questions = 0;
  let written = false;
  await updatePersonalCover(
    where.org,
    where.principalKey,
    (current, existed) => {
      if (!existed) return undefined;
      wasOn = current.on;
      questions = current.entries.length;
      if (!current.on) return undefined;
      written = true;
      const { until: _u, ...rest } = current;
      return { ...rest, on: false, setAt: at, recapDue: current.entries.length > 0, recapTries: 0 };
    },
    at,
  );
  if (written) {
    await appendAudit({
      org: where.org,
      platform: where.platform,
      workspace: where.workspace,
      surface: where.surface,
      principalId: where.principalKey,
      action: COVER_SET_ACTION,
      detail: { on: false, questions, via },
    }).catch(() => undefined);
  }
  return { wasOn, questions, written };
}

export async function recordCoverQuestion(org: string, principalKey: string, entry: CoverEntry, now = new Date()): Promise<boolean> {
  let kept = false;
  await updatePersonalCover(
    org,
    principalKey,
    (current, existed) => {
      if (!existed || !coverLive(current, now)) return undefined;
      if (current.entries.some((e) => e.wakeId === entry.wakeId)) return undefined;
      kept = true;
      return { ...current, entries: [...current.entries, entry] };
    },
    now.toISOString(),
  );
  return kept;
}

export async function recordCoverAnswer(org: string, principalKey: string, wakeId: string, answer: string, at = new Date().toISOString()): Promise<boolean> {
  let attached = false;
  await updatePersonalCover(
    org,
    principalKey,
    (current) => {
      const i = current.entries.findIndex((e) => e.wakeId === wakeId);
      if (i < 0 || current.entries[i]!.answer !== undefined) return undefined;
      attached = true;
      const entries = current.entries.map((e, j) => (j === i ? { ...e, answer: clipCoverText(answer) } : e));
      return { ...current, entries };
    },
    at,
  );
  return attached;
}
