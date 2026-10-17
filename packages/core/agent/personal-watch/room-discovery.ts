import { appendAudit } from "../audit/audit.js";
import { readPersonOptOut } from "../identity/person-opt-out.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import type { QuestionLedgerRow, RoomConnectorCallRow } from "../operational/store.js";
import type { Partition } from "../memory/partition.js";
import type { RoutineCreateArgs } from "../approvals/routine-create.js";
import {
  DISCOVERY_READ_LIMIT,
  DISCOVERY_SCAN_EVERY_HOURS,
  DISCOVERY_WINDOW_DAYS,
  discoveryMinWeeks,
  discoveryOn,
  findWeekly,
  proposalCron,
  proposalPrompt,
  repeatedWorkSummary,
  repeatedWorkWords,
  strongestFirst,
  type RepeatedWork,
  type WeeklyEvent,
} from "./discovery.js";
import { parseProposalRecords, PROPOSAL_LOG_MAX, type WatchProposalOutcome, type WatchProposalRecord } from "./state.js";

export const ROOM_MIN_PEOPLE = 2;
export const ROOM_PROPOSAL_GAP_DAYS = 14;
export const ROOM_SCAN_KEY = "scan";
export const ROOM_DISCOVERY_REQUESTER = "oe:room-discovery";

const DAY_MS = 86_400_000;

export interface RoomWatchState {
  readonly proposals: readonly WatchProposalRecord[];
  readonly lastDiscoveryAt?: string;
}

export function parseRoomState(json: string): RoomWatchState {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const last = typeof raw["lastDiscoveryAt"] === "string" ? raw["lastDiscoveryAt"] : undefined;
  return { proposals: parseProposalRecords(raw["proposals"]), ...(last !== undefined ? { lastDiscoveryAt: last } : {}) };
}

export async function updateRoomWatch(
  org: string,
  surfaceKey: string,
  mutate: (current: RoomWatchState, existed: boolean) => RoomWatchState | undefined,
  at = new Date().toISOString(),
): Promise<RoomWatchState | undefined> {
  const store = getOperationalStore();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await store.getRoomWatch(org, surfaceKey);
    const current = row ? parseRoomState(row.stateJson) : { proposals: [] };
    const next = mutate(current, row !== null);
    if (next === undefined) return undefined;
    const capped = { ...next, proposals: next.proposals.slice(-PROPOSAL_LOG_MAX) };
    const written = await store.casRoomWatch(org, surfaceKey, JSON.stringify(capped), at, row ? row.version : null);
    if (written !== null) return capped;
  }
  throw new Error(`the room row for ${surfaceKey} changed under three writes in a row`);
}

export async function recordRoomProposalOutcome(org: string, surfaceKey: string, fingerprint: string, outcome: WatchProposalOutcome, at = new Date().toISOString()): Promise<"recorded" | "unchanged" | "unknown"> {
  let answer: "recorded" | "unchanged" | "unknown" = "unknown";
  await updateRoomWatch(
    org,
    surfaceKey,
    (cur, existed) => {
      const i = existed ? cur.proposals.findIndex((p) => p.fingerprint === fingerprint) : -1;
      if (i < 0) {
        answer = "unknown";
        return undefined;
      }
      if (cur.proposals[i]!.outcome !== undefined) {
        answer = "unchanged";
        return undefined;
      }
      answer = "recorded";
      return { ...cur, proposals: cur.proposals.map((p, j) => (j === i ? { ...p, outcome, decidedAt: at } : p)) };
    },
    at,
  );
  return answer;
}

export function findRoomPatterns(calls: readonly RoomConnectorCallRow[], questions: readonly QuestionLedgerRow[], now: Date, minWeeks: number): Map<string, RepeatedWork[]> {
  const rooms = new Map<string, { calls: RoomConnectorCallRow[]; questions: QuestionLedgerRow[] }>();
  const room = (key: string) => {
    let r = rooms.get(key);
    if (!r) {
      r = { calls: [], questions: [] };
      rooms.set(key, r);
    }
    return r;
  };
  for (const c of calls) if (c.connector.length > 0) room(c.surfaceKey).calls.push(c);
  for (const q of questions) room(q.surfaceKey).questions.push(q);
  const out = new Map<string, RepeatedWork[]>();
  for (const [surfaceKey, r] of [...rooms].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ops = new Map<string, RoomConnectorCallRow>();
    for (const c of r.calls) if (!ops.has(`${c.connector}/${c.tool}`)) ops.set(`${c.connector}/${c.tool}`, c);
    const words = new Map<string, string>();
    for (const q of r.questions) if (!words.has(q.fingerprint)) words.set(q.fingerprint, q.words);
    const soloOps = new Set<string>();
    const byPerson = new Map<string, WeeklyEvent[]>();
    for (const c of r.calls) {
      const list = byPerson.get(c.principalId) ?? [];
      list.push({ ts: c.ts, key: `${c.connector}/${c.tool}` });
      byPerson.set(c.principalId, list);
    }
    for (const events of byPerson.values()) for (const p of findWeekly(events, now, minWeeks)) soloOps.add(`${p.key}:${p.weekday}`);
    const found: RepeatedWork[] = [
      ...findWeekly(
        r.calls.map((c) => ({ ts: c.ts, key: `${c.connector}/${c.tool}`, person: c.principalId })),
        now,
        minWeeks,
        ROOM_MIN_PEOPLE,
      )
        .filter((p) => !soloOps.has(`${p.key}:${p.weekday}`))
        .map((p) => {
        const op = ops.get(p.key)!;
        return { fingerprint: `weekly:${p.key}:${p.weekday}`, connector: op.connector, tool: op.tool, weekday: p.weekday, hour: p.hour, weeks: p.weeks, people: p.people };
      }),
      ...findWeekly(
        r.questions.map((q) => ({ ts: q.ts, key: q.fingerprint, person: q.principalId })),
        now,
        minWeeks,
        ROOM_MIN_PEOPLE,
      ).map((p) => ({ fingerprint: `weekly:q:${p.key}:${p.weekday}`, connector: "", tool: "", question: words.get(p.key)!, weekday: p.weekday, hour: p.hour, weeks: p.weeks, people: p.people })),
    ];
    if (found.length > 0) out.set(surfaceKey, strongestFirst(found));
  }
  return out;
}

export function roomProposalDue(state: Pick<RoomWatchState, "proposals">, now: Date): boolean {
  const last = state.proposals.reduce((m, p) => Math.max(m, Date.parse(p.at) || 0), 0);
  return last === 0 || now.getTime() - last >= ROOM_PROPOSAL_GAP_DAYS * DAY_MS;
}

export interface RoomRoutineSuggestArgs {
  readonly scope: "room";
  readonly org: string;
  readonly surfaceKey: string;
  readonly fingerprint: string;
  readonly summary: string;
  readonly work: string;
  readonly weeks: number;
  readonly people: number;
  readonly create: Omit<RoutineCreateArgs, "createdBy">;
}

export function roomRoutineSuggestArgs(input: { readonly org: string; readonly surfaceKey: string; readonly target: unknown; readonly work: RepeatedWork }): RoomRoutineSuggestArgs {
  const [platform = "", workspace = "", ...rest] = input.surfaceKey.split("/");
  const surface = rest.join("/");
  const workspaceKey = `${platform}/${workspace}`;
  const partition: Partition = { org: input.org, platform, workspace, surface, workspaceKey, surfaceKey: input.surfaceKey, domainKey: input.surfaceKey, key: input.surfaceKey };
  return {
    scope: "room",
    org: input.org,
    surfaceKey: input.surfaceKey,
    fingerprint: input.work.fingerprint,
    summary: repeatedWorkSummary(input.work),
    work: repeatedWorkWords(input.work),
    weeks: input.work.weeks,
    people: input.work.people ?? ROOM_MIN_PEOPLE,
    create: {
      org: input.org,
      partition,
      surfaceKey: input.surfaceKey,
      target: input.target,
      trigger: { kind: "cron", expr: proposalCron(input.work) },
      prompt: proposalPrompt(input.work, "room"),
    },
  };
}

export type ProposeRoomRoutine = (input: {
  readonly org: string;
  readonly surfaceKey: string;
  readonly work: RepeatedWork;
}) => Promise<{ readonly ok: true; readonly cardId: string } | { readonly ok: false; readonly reason: string; readonly keep?: true }>;

export interface RoomDiscoveryDeps {
  readonly proposeRoom: ProposeRoomRoutine;
  readonly readRoomCalls?: (org: string, since: string, limit: number) => Promise<RoomConnectorCallRow[]>;
  readonly readRoomQuestions?: (org: string, since: string, limit: number) => Promise<QuestionLedgerRow[]>;
  readonly optedOut?: (org: string, principalKey: string) => Promise<boolean>;
}

async function liveOptedOut(org: string, principalKey: string): Promise<boolean> {
  return (await readPersonOptOut(org, principalKey)).optedOut;
}

export async function withoutOptedOut(org: string, rows: readonly QuestionLedgerRow[], optedOut: (org: string, principalKey: string) => Promise<boolean>): Promise<QuestionLedgerRow[]> {
  const verdict = new Map<string, boolean>();
  for (const r of rows) {
    const [platform = "", tenant = ""] = r.surfaceKey.split("/");
    const key = tryPrincipalKey(platform, tenant, r.principalId);
    if (key === undefined || verdict.has(key)) continue;
    verdict.set(key, await optedOut(org, key).catch(() => true));
  }
  return rows.filter((r) => {
    const [platform = "", tenant = ""] = r.surfaceKey.split("/");
    const key = tryPrincipalKey(platform, tenant, r.principalId);
    return key !== undefined && verdict.get(key) === false;
  });
}

export interface RoomDiscoveryReport {
  readonly rooms: number;
  readonly proposed: number;
}

export async function roomDiscoveryTick(org: string, deps: RoomDiscoveryDeps, now: Date): Promise<RoomDiscoveryReport> {
  const report = { rooms: 0, proposed: 0 };
  if (!discoveryOn()) return report;
  try {
    const due = (s: RoomWatchState) => {
      const last = s.lastDiscoveryAt !== undefined ? Date.parse(s.lastDiscoveryAt) : NaN;
      return !Number.isFinite(last) || now.getTime() - last >= DISCOVERY_SCAN_EVERY_HOURS * 3_600_000;
    };
    const claimed = await updateRoomWatch(org, ROOM_SCAN_KEY, (cur) => (due(cur) ? { ...cur, lastDiscoveryAt: now.toISOString() } : undefined), now.toISOString());
    if (!claimed) return report;
    const since = new Date(now.getTime() - DISCOVERY_WINDOW_DAYS * DAY_MS).toISOString();
    const store = getOperationalStore();
    const limit = DISCOVERY_READ_LIMIT * 5;
    const calls = await (deps.readRoomCalls ?? ((o, s, l) => store.listRoomConnectorCalls(o, s, l)))(org, since, limit);
    const asked = await (deps.readRoomQuestions ?? ((o, s, l) => store.listRoomQuestions(o, s, l)))(org, since, limit);
    const questions = await withoutOptedOut(org, asked, deps.optedOut ?? liveOptedOut);
    for (const [name, rows] of [["connector", calls], ["question", asked]] as const) {
      if (rows.length >= limit) console.warn(`[open-everywhere:room-discovery] the room ${name} read hit its cap of ${limit} rows, so the oldest weeks may be cut and a pattern missed`);
    }
    const patterns = findRoomPatterns(calls, questions, now, discoveryMinWeeks());
    report.rooms = patterns.size;
    for (const [surfaceKey, found] of patterns) {
      if (await proposeInRoom(org, surfaceKey, found, deps, now)) report.proposed++;
    }
  } catch (err) {
    console.warn(`[open-everywhere:room-discovery] the room scan failed: ${String(err)}`);
  }
  return report;
}

async function proposeInRoom(org: string, surfaceKey: string, found: readonly RepeatedWork[], deps: RoomDiscoveryDeps, now: Date): Promise<boolean> {
  try {
    let work: RepeatedWork | undefined;
    const reserved = await updateRoomWatch(
      org,
      surfaceKey,
      (cur) => {
        if (!roomProposalDue(cur, now)) return undefined;
        const offered = new Set(cur.proposals.map((p) => p.fingerprint));
        work = found.find((w) => !offered.has(w.fingerprint));
        if (!work) return undefined;
        return { ...cur, proposals: [...cur.proposals, { fingerprint: work.fingerprint, summary: repeatedWorkSummary(work), at: now.toISOString() }] };
      },
      now.toISOString(),
    );
    if (!reserved || !work) return false;
    const chosen: RepeatedWork = work;
    const posted = await deps.proposeRoom({ org, surfaceKey, work: chosen }).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    const [platform = "unknown", workspace = "", ...rest] = surfaceKey.split("/");
    if (!posted.ok && "keep" in posted && posted.keep === true) {
      console.warn(`[open-everywhere:room-discovery] a routine proposal for ${surfaceKey} was refused and stays reserved: ${posted.reason}`);
      return false;
    }
    if (!posted.ok) {
      await updateRoomWatch(org, surfaceKey, (cur) => ({ ...cur, proposals: cur.proposals.filter((p) => !(p.fingerprint === chosen.fingerprint && p.at === now.toISOString())) })).catch(() => undefined);
      console.warn(`[open-everywhere:room-discovery] a routine proposal for ${surfaceKey} did not post: ${posted.reason}`);
      return false;
    }
    await appendAudit({
      org,
      platform,
      workspace,
      surface: rest.join("/"),
      action: "room_watch.proposal",
      detail: { fingerprint: chosen.fingerprint, kind: chosen.question !== undefined ? "question" : "connector-op", connector: chosen.connector, tool: chosen.tool, weekday: chosen.weekday, hour: chosen.hour, weeks: chosen.weeks, people: chosen.people ?? 0 },
    }).catch(() => undefined);
    return true;
  } catch (err) {
    console.warn(`[open-everywhere:room-discovery] room discovery failed for ${surfaceKey}: ${String(err)}`);
    return false;
  }
}
