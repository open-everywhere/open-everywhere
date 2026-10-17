import { appendAudit, noteAuditDrop } from "../audit/audit.js";
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
export const ROOM_SCAN_BUDGET_MS = 2 * 60_000;
export const ROOM_READ_LIMIT = DISCOVERY_READ_LIMIT * 5;

export const ROOM_SILENCE_REASONS = ["room-stopped", "proposal-gap", "delivery-refused"] as const;
export type RoomSilenceReason = (typeof ROOM_SILENCE_REASONS)[number];
const STOPPED_KEY = "stopped";

const DAY_MS = 86_400_000;

export interface RoomWatchState {
  readonly proposals: readonly WatchProposalRecord[];
  readonly lastDiscoveryAt?: string;
  readonly resumeAfter?: string;
  readonly stoppedAt?: string;
  readonly silence?: { readonly key: string; readonly reason: RoomSilenceReason };
}

export function parseRoomState(json: string): RoomWatchState {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const last = typeof raw["lastDiscoveryAt"] === "string" ? raw["lastDiscoveryAt"] : undefined;
  const stoppedAt = typeof raw["stoppedAt"] === "string" ? raw["stoppedAt"] : undefined;
  const resumeAfter = typeof raw["resumeAfter"] === "string" ? raw["resumeAfter"] : undefined;
  const sil = raw["silence"] as { key?: unknown; reason?: unknown } | undefined;
  const silence =
    sil && typeof sil.key === "string" && (ROOM_SILENCE_REASONS as readonly unknown[]).includes(sil.reason) ? { key: sil.key, reason: sil.reason as RoomSilenceReason } : undefined;
  return {
    proposals: parseProposalRecords(raw["proposals"]),
    ...(last !== undefined ? { lastDiscoveryAt: last } : {}),
    ...(resumeAfter !== undefined ? { resumeAfter } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(silence !== undefined ? { silence } : {}),
  };
}

function withoutSilence(state: RoomWatchState): RoomWatchState {
  const { silence: _drop, ...rest } = state;
  return rest;
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

export interface RoomStopWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly surfaceKey: string;
  readonly principalKey: string;
}

export async function readRoomStop(org: string, surfaceKey: string): Promise<{ readonly stopped: boolean; readonly readable: boolean }> {
  try {
    const row = await getOperationalStore().getRoomWatch(org, surfaceKey);
    return { stopped: row !== null && parseRoomState(row.stateJson).stoppedAt !== undefined, readable: true };
  } catch (err) {
    console.warn(`[open-everywhere:room-discovery] the room row for ${surfaceKey} could not be read: ${String(err)}`);
    return { stopped: true, readable: false };
  }
}

export async function stopRoomDiscovery(where: RoomStopWhere, at = new Date().toISOString()): Promise<{ readonly changed: boolean }> {
  let changed = false;
  await updateRoomWatch(
    where.org,
    where.surfaceKey,
    (cur) => {
      changed = cur.stoppedAt === undefined;
      return changed ? { ...cur, stoppedAt: at } : undefined;
    },
    at,
  );
  await noteStopChange("room_watch.stopped", where, changed);
  return { changed };
}

export async function resumeRoomDiscovery(where: RoomStopWhere, at = new Date().toISOString()): Promise<{ readonly changed: boolean }> {
  let changed = false;
  await updateRoomWatch(
    where.org,
    where.surfaceKey,
    (cur, existed) => {
      changed = existed && cur.stoppedAt !== undefined;
      if (!changed) return undefined;
      const { stoppedAt: _drop, ...rest } = withoutSilence(cur);
      return rest;
    },
    at,
  );
  await noteStopChange("room_watch.resumed", where, changed);
  return { changed };
}

async function noteStopChange(action: "room_watch.stopped" | "room_watch.resumed", where: RoomStopWhere, changed: boolean): Promise<void> {
  const row = { org: where.org, platform: where.platform, workspace: where.workspace, surface: where.surface, principalId: where.principalKey, detail: { changed, via: "command" } };
  const written = action === "room_watch.stopped" ? appendAudit({ ...row, action: "room_watch.stopped" }) : appendAudit({ ...row, action: "room_watch.resumed" });
  await written.catch((err: unknown) => console.warn(`[open-everywhere:room-discovery] ${action} row was not written: ${String(err)}`));
}

export async function fileRoomSilence(org: string, surfaceKey: string, reason: RoomSilenceReason, work: RepeatedWork | undefined, now: Date): Promise<boolean> {
  const key = reason === "room-stopped" ? STOPPED_KEY : (work?.fingerprint ?? STOPPED_KEY);
  try {
    const row = await getOperationalStore().getRoomWatch(org, surfaceKey);
    const last = row ? parseRoomState(row.stateJson).silence : undefined;
    if (last?.key === key && last.reason === reason) return false;
    const [platform = "unknown", workspace = "", ...rest] = surfaceKey.split("/");
    const ts = now.toISOString();
    const attempt = (): Promise<boolean> =>
      getOperationalStore()
        .appendAudit({
          ts,
          org,
          platform,
          workspace,
          surface: rest.join("/"),
          action: "room_watch.silence",
          detail: { reason, fingerprint: work?.fingerprint ?? "", kind: work === undefined ? "" : work.question !== undefined ? "question" : "connector-op", summary: work ? repeatedWorkSummary(work) : "" },
        })
        .then(
          () => true,
          () => false,
        );
    const landed = (await attempt()) || (await attempt());
    if (!landed) {
      noteAuditDrop("room_watch.silence", platform);
      return false;
    }
    await updateRoomWatch(org, surfaceKey, (cur) => (reason === "room-stopped" && cur.stoppedAt === undefined ? undefined : { ...cur, silence: { key, reason } }), ts).catch(() => undefined);
    return true;
  } catch (err) {
    console.warn(`[open-everywhere:room-discovery] a hold for ${surfaceKey} filed no row: ${String(err)}`);
    return false;
  }
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
  readonly listRooms?: (org: string, since: string) => Promise<string[]>;
  readonly readRoomCalls?: (org: string, surfaceKey: string, since: string, limit: number) => Promise<RoomConnectorCallRow[]>;
  readonly readRoomQuestions?: (org: string, surfaceKey: string, since: string, limit: number) => Promise<QuestionLedgerRow[]>;
  readonly budgetMs?: number;
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
  readonly held: number;
}

export async function roomDiscoveryTick(org: string, deps: RoomDiscoveryDeps, now: Date): Promise<RoomDiscoveryReport> {
  const report = { rooms: 0, proposed: 0, held: 0 };
  if (!discoveryOn()) return report;
  let resumeAfter: string | undefined;
  let scanned = 0;
  try {
    const due = (s: RoomWatchState) => {
      const last = s.lastDiscoveryAt !== undefined ? Date.parse(s.lastDiscoveryAt) : NaN;
      return !Number.isFinite(last) || now.getTime() - last >= DISCOVERY_SCAN_EVERY_HOURS * 3_600_000;
    };
    const claimed = await updateRoomWatch(
      org,
      ROOM_SCAN_KEY,
      (cur) => {
        if (cur.resumeAfter !== undefined) {
          resumeAfter = cur.resumeAfter;
          const { resumeAfter: _drop, ...rest } = cur;
          return rest;
        }
        resumeAfter = undefined;
        return due(cur) ? { ...cur, lastDiscoveryAt: now.toISOString() } : undefined;
      },
      now.toISOString(),
    );
    if (!claimed) return report;
    const since = new Date(now.getTime() - DISCOVERY_WINDOW_DAYS * DAY_MS).toISOString();
    const store = getOperationalStore();
    const rooms = (await (deps.listRooms ?? ((o, s) => store.listDiscoveryRooms(o, s)))(org, since)).filter((k) => k !== ROOM_SCAN_KEY).sort();
    const minWeeks = discoveryMinWeeks();
    const started = Date.now();
    const budget = deps.budgetMs ?? ROOM_SCAN_BUDGET_MS;
    for (const surfaceKey of rooms) {
      if (resumeAfter !== undefined && surfaceKey <= resumeAfter) continue;
      if (scanned > 0 && Date.now() - started >= budget) {
        const last = rooms[rooms.indexOf(surfaceKey) - 1]!;
        await updateRoomWatch(org, ROOM_SCAN_KEY, (cur) => ({ ...cur, resumeAfter: last }), now.toISOString());
        console.warn(`[open-everywhere:room-discovery] the room scan ran out of time after ${scanned} room(s); the next tick resumes it`);
        break;
      }
      const outcome = await scanRoom(org, surfaceKey, since, minWeeks, deps, now);
      scanned++;
      if (outcome.pattern) report.rooms++;
      if (outcome.result === "proposed") report.proposed++;
      if (outcome.result === "held") report.held++;
    }
  } catch (err) {
    console.warn(`[open-everywhere:room-discovery] the room scan failed: ${String(err)}`);
    const cursor = resumeAfter;
    if (cursor !== undefined && scanned === 0) await updateRoomWatch(org, ROOM_SCAN_KEY, (cur) => ({ ...cur, resumeAfter: cursor })).catch(() => undefined);
  }
  return report;
}

async function scanRoom(org: string, surfaceKey: string, since: string, minWeeks: number, deps: RoomDiscoveryDeps, now: Date): Promise<{ readonly pattern: boolean; readonly result: "proposed" | "held" | "none" }> {
  try {
    const stop = await readRoomStop(org, surfaceKey);
    if (!stop.readable) return { pattern: false, result: "none" };
    if (stop.stopped) {
      await fileRoomSilence(org, surfaceKey, "room-stopped", undefined, now);
      return { pattern: false, result: "held" };
    }
    const store = getOperationalStore();
    const calls = await (deps.readRoomCalls ?? ((o, k, s, l) => store.listRoomConnectorCalls(o, k, s, l)))(org, surfaceKey, since, ROOM_READ_LIMIT);
    const asked = await (deps.readRoomQuestions ?? ((o, k, s, l) => store.listRoomQuestions(o, k, s, l)))(org, surfaceKey, since, ROOM_READ_LIMIT);
    for (const [name, rows] of [["connector", calls], ["question", asked]] as const) {
      if (rows.length >= ROOM_READ_LIMIT) console.warn(`[open-everywhere:room-discovery] the ${name} read for ${surfaceKey} hit its cap of ${ROOM_READ_LIMIT} rows, so the oldest weeks of this room may be cut`);
    }
    const questions = await withoutOptedOut(org, asked, deps.optedOut ?? liveOptedOut);
    const found = findRoomPatterns(
      calls.filter((c) => c.surfaceKey === surfaceKey),
      questions.filter((q) => q.surfaceKey === surfaceKey),
      now,
      minWeeks,
    ).get(surfaceKey);
    if (!found || found.length === 0) return { pattern: false, result: "none" };
    const outcome = await proposeInRoom(org, surfaceKey, found, deps, now);
    if (outcome.held) await fileRoomSilence(org, surfaceKey, outcome.held.reason, outcome.held.work, now);
    return { pattern: true, result: outcome.proposed ? "proposed" : outcome.held ? "held" : "none" };
  } catch (err) {
    console.warn(`[open-everywhere:room-discovery] room discovery failed for ${surfaceKey}: ${String(err)}`);
    return { pattern: false, result: "none" };
  }
}

interface RoomProposalOutcome {
  readonly proposed: boolean;
  readonly held?: { readonly work: RepeatedWork; readonly reason: RoomSilenceReason };
}

async function proposeInRoom(org: string, surfaceKey: string, found: readonly RepeatedWork[], deps: RoomDiscoveryDeps, now: Date): Promise<RoomProposalOutcome> {
  let work: RepeatedWork | undefined;
  let hold: RoomSilenceReason | undefined;
  const reserved = await updateRoomWatch(
    org,
    surfaceKey,
    (cur) => {
      const offered = new Set(cur.proposals.map((p) => p.fingerprint));
      work = found.find((w) => !offered.has(w.fingerprint));
      if (!work) return undefined;
      if (cur.stoppedAt !== undefined) hold = "room-stopped";
      else if (!roomProposalDue(cur, now)) hold = "proposal-gap";
      if (hold !== undefined) return undefined;
      return { ...cur, proposals: [...cur.proposals, { fingerprint: work.fingerprint, summary: repeatedWorkSummary(work), at: now.toISOString() }] };
    },
    now.toISOString(),
  );
  if (!work) return { proposed: false };
  const chosen: RepeatedWork = work;
  if (hold !== undefined) return { proposed: false, held: { work: chosen, reason: hold } };
  if (!reserved) return { proposed: false };
  const posted = await deps.proposeRoom({ org, surfaceKey, work: chosen }).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
  const [platform = "unknown", workspace = "", ...rest] = surfaceKey.split("/");
  if (!posted.ok && "keep" in posted && posted.keep === true) {
    console.warn(`[open-everywhere:room-discovery] a routine proposal for ${surfaceKey} was refused and stays reserved: ${posted.reason}`);
    return { proposed: false, held: { work: chosen, reason: "delivery-refused" } };
  }
  if (!posted.ok) {
    await updateRoomWatch(org, surfaceKey, (cur) => ({ ...cur, proposals: cur.proposals.filter((p) => !(p.fingerprint === chosen.fingerprint && p.at === now.toISOString())) })).catch(() => undefined);
    console.warn(`[open-everywhere:room-discovery] a routine proposal for ${surfaceKey} did not post: ${posted.reason}`);
    return { proposed: false, held: { work: chosen, reason: "delivery-refused" } };
  }
  await updateRoomWatch(org, surfaceKey, (cur) => (cur.silence !== undefined ? withoutSilence(cur) : undefined)).catch(() => undefined);
  await appendAudit({
    org,
    platform,
    workspace,
    surface: rest.join("/"),
    action: "room_watch.proposal",
    detail: { fingerprint: chosen.fingerprint, kind: chosen.question !== undefined ? "question" : "connector-op", connector: chosen.connector, tool: chosen.tool, weekday: chosen.weekday, hour: chosen.hour, weeks: chosen.weeks, people: chosen.people ?? 0 },
  }).catch(() => undefined);
  return { proposed: true };
}
