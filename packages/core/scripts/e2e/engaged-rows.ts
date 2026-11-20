import { pollOptional, type PollOpts } from "./poll.js";
import type { AuditQueryOpts, AuditWireEntry } from "./audit-read.js";
import { WORKER_TOOLSET_ACTION } from "./gate-joins.js";

export const STOOD_DOWN_ACTION = "engagement.stood_down";

export const REPLY_POST_ACTION = "reply.post";

export const WAKE_INGRESS_ACTION = "wake.ingress";

export function dispatchedAction(platform: string): string {
  return `${platform}.dispatched`;
}

function detail(row: AuditWireEntry): Readonly<Record<string, unknown>> {
  return row.detail ?? {};
}

function detailString(row: AuditWireEntry, key: string): string | undefined {
  const v = detail(row)[key];
  return typeof v === "string" ? v : undefined;
}

export function standDownRows(
  rows: readonly AuditWireEntry[],
  opts: { readonly surface?: string; readonly anchor?: string } = {},
): readonly AuditWireEntry[] {
  return rows.filter(
    (r) =>
      r.action === STOOD_DOWN_ACTION &&
      (opts.surface === undefined || r.surface === opts.surface || detailString(r, "surfaceKey") === opts.surface) &&
      (opts.anchor === undefined || detailString(r, "anchor") === opts.anchor),
  );
}

export function standDownReachedRegistry(row: AuditWireEntry): boolean {
  return typeof detail(row)["marked"] === "boolean";
}

export function standDownMarked(
  rows: readonly AuditWireEntry[],
  opts: { readonly surface?: string; readonly anchor?: string } = {},
): boolean {
  return standDownRows(rows, opts).some((r) => detail(r)["marked"] === true);
}

export function standDownAttemptedButUnmarked(
  rows: readonly AuditWireEntry[],
  opts: { readonly surface?: string; readonly anchor?: string } = {},
): boolean {
  return standDownRows(rows, opts).some((r) => detail(r)["marked"] === false);
}

export function dispatchAddressings(rows: readonly AuditWireEntry[], platform: string): readonly string[] {
  const action = dispatchedAction(platform);
  return rows.filter((r) => r.action === action).flatMap((r) => {
    const a = detailString(r, "addressing");
    return a === undefined ? [] : [a];
  });
}

export const AMBIENT_LEG_ADDRESSINGS: readonly string[] = ["channel-watch", "thread-follow"];

export function isAmbientLegAddressing(value: unknown): boolean {
  return typeof value === "string" && AMBIENT_LEG_ADDRESSINGS.includes(value);
}

export function reportedThreadFollow(rows: readonly AuditWireEntry[], platform: string): boolean {
  return dispatchAddressings(rows, platform).includes("thread-follow");
}

export function reportedSeatedChannelWatch(rows: readonly AuditWireEntry[], platform: string, channelId: string): boolean {
  const action = dispatchedAction(platform);
  return rows.some(
    (r) =>
      r.action === action &&
      detailString(r, "addressing") === "channel-watch" &&
      detail(r)["singleWindow"] === true &&
      detailString(r, "channelId") === channelId,
  );
}

export function reportedDirectMention(rows: readonly AuditWireEntry[], platform: string): boolean {
  const seen = dispatchAddressings(rows, platform);
  return seen.includes("direct-mention") || seen.includes("direct");
}

export function reportedNameDrop(rows: readonly AuditWireEntry[], platform: string): boolean {
  return dispatchAddressings(rows, platform).includes("name-drop");
}

export const NO_REPLY_OBSERVED_ACTION = "reply.no_reply_observed";

export type EngagedFollowUpDiagnosis =
  | { readonly kind: "answered"; readonly addressing: string; readonly wakeIds: readonly string[] }
  | { readonly kind: "admitted-silent"; readonly addressing: string; readonly wakeIds: readonly string[]; readonly reasons: readonly string[] }
  | { readonly kind: "admitted-unsettled"; readonly addressing: string; readonly wakeIds: readonly string[] }
  | { readonly kind: "admitted-unjoined"; readonly addressing: string }
  | { readonly kind: "not-admitted"; readonly seen: readonly string[] }
  | { readonly kind: "unreported" };

export function diagnoseEngagedFollowUp(
  rows: readonly AuditWireEntry[],
  platform: string,
  expect = "thread-follow",
): EngagedFollowUpDiagnosis {
  const action = dispatchedAction(platform);
  const wakeIds = [
    ...new Set(
      rows
        .filter((r) => r.action === action && detailString(r, "addressing") === expect)
        .map((r) => detailString(r, "wakeId"))
        .filter((id): id is string => id !== undefined && id.length > 0),
    ),
  ];
  if (wakeIds.length === 0) {
    const seen = dispatchAddressings(rows, platform);
    if (seen.length === 0) return { kind: "unreported" };
    return seen.includes(expect) ? { kind: "admitted-unjoined", addressing: expect } : { kind: "not-admitted", seen };
  }
  const ofAdmitted = (r: AuditWireEntry, a: string): boolean => {
    if (r.action !== a) return false;
    const id = detailString(r, "wakeId");
    return id !== undefined && wakeIds.includes(id);
  };
  if (rows.some((r) => ofAdmitted(r, REPLY_POST_ACTION))) return { kind: "answered", addressing: expect, wakeIds };
  const silences = rows.filter((r) => ofAdmitted(r, NO_REPLY_OBSERVED_ACTION));
  if (silences.length > 0) {
    const reasons = [...new Set(silences.map((r) => detailString(r, "reason") ?? "unstated"))];
    return { kind: "admitted-silent", addressing: expect, wakeIds, reasons };
  }
  return { kind: "admitted-unsettled", addressing: expect, wakeIds };
}

export function describeEngagedFollowUp(d: EngagedFollowUpDiagnosis, platform: string): string {
  const dispatched = dispatchedAction(platform);
  switch (d.kind) {
    case "answered":
      return `ADMITTED (${dispatched} addressing=${d.addressing}) and ANSWERED (a ${REPLY_POST_ACTION} row carries the admitted wake id)`;
    case "admitted-silent":
      return (
        `ADMITTED (${dispatched} addressing=${d.addressing}, wake ${d.wakeIds.join(",")}), then the seat chose SILENCE ` +
        `(${NO_REPLY_OBSERVED_ACTION} reason=${d.reasons.join(",")}). This is a seat-judgement red, NOT an admission red: ` +
        `read the seat transcript for that wake`
      );
    case "admitted-unsettled":
      return `ADMITTED (${dispatched} addressing=${d.addressing}, wake ${d.wakeIds.join(",")}), but no ${REPLY_POST_ACTION} and no ${NO_REPLY_OBSERVED_ACTION} row carries that wake id: the turn did not settle in the window, or it settled under another wake id`;
    case "admitted-unjoined":
      return `ADMITTED (${dispatched} addressing=${d.addressing}), but the row carries no wake id, so no reply or silence row can be joined to it`;
    case "not-admitted":
      return `NOT ADMITTED on the engaged road: no ${dispatched} row reports the expected addressing (saw ${JSON.stringify(d.seen)}). This is an admission red`;
    case "unreported":
      return `no ${dispatched} row in the window, so the rows cannot say whether the follow-up was admitted`;
  }
}

export function replyPostCount(rows: readonly AuditWireEntry[], opts: { readonly surface?: string } = {}): number {
  return rows.filter((r) => r.action === REPLY_POST_ACTION && (opts.surface === undefined || r.surface === opts.surface)).length;
}

export function replyPostSurfaces(rows: readonly AuditWireEntry[]): readonly string[] {
  const seen: string[] = [];
  for (const r of rows) {
    if (r.action !== REPLY_POST_ACTION) continue;
    const s = r.surface;
    if (typeof s !== "string" || s.length === 0) continue;
    if (!seen.includes(s)) seen.push(s);
  }
  return seen;
}

export function replyPostHighWater(rows: readonly AuditWireEntry[]): { readonly seq: number; readonly unsequenced: number } {
  let seq = 0;
  let unsequenced = 0;
  for (const r of rows) {
    if (r.action !== REPLY_POST_ACTION) continue;
    if (typeof r.seq !== "number") {
      unsequenced += 1;
      continue;
    }
    if (r.seq > seq) seq = r.seq;
  }
  return { seq, unsequenced };
}

export function replyPostsAfter(
  rows: readonly AuditWireEntry[],
  highWater: number,
  opts: { readonly surface: string },
): readonly AuditWireEntry[] {
  return rows.filter(
    (r) => r.action === REPLY_POST_ACTION && r.surface === opts.surface && (typeof r.seq !== "number" || r.seq > highWater),
  );
}

export const CONTROL_SERVICE_CALL_ACTION = "control.service_call";

export function auditStoreHighWater(rows: readonly AuditWireEntry[]): { readonly seq: number; readonly unsequenced: number } {
  let seq = 0;
  let unsequenced = 0;
  for (const r of rows) {
    if (typeof r.seq !== "number") {
      unsequenced += 1;
      continue;
    }
    if (r.seq > seq) seq = r.seq;
  }
  return { seq, unsequenced };
}

export function rowsAboveStoreMark(rows: readonly AuditWireEntry[], mark: number): readonly AuditWireEntry[] {
  return rows.filter((r) => typeof r.seq !== "number" || r.seq > mark);
}

export const STORE_MARK_LOOKBACK_MS = 10 * 60_000;

export async function readAuditStoreMark(
  read: (opts: { readonly sinceIso: string; readonly actions: readonly string[]; readonly limit: number }) => Promise<readonly AuditWireEntry[]>,
  nowMs: number,
): Promise<{ readonly seq: number; readonly unsequenced: number; readonly rows: number; readonly deploymentMs: number | undefined }> {
  const rows = await read({ sinceIso: new Date(nowMs - STORE_MARK_LOOKBACK_MS).toISOString(), actions: [CONTROL_SERVICE_CALL_ACTION], limit: 50 });
  return { ...auditStoreHighWater(rows), rows: rows.length, deploymentMs: auditStoreMarkInstantMs(rows) };
}

export function auditStoreMarkInstantMs(rows: readonly AuditWireEntry[]): number | undefined {
  let best: { readonly seq: number; readonly ms: number } | undefined;
  for (const r of rows) {
    if (typeof r.seq !== "number") continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    if (best === undefined || r.seq > best.seq) best = { seq: r.seq, ms };
  }
  return best?.ms;
}

export async function readPresenceSince(
  read: (opts: { readonly sinceIso: string; readonly actions: readonly string[]; readonly limit: number }) => Promise<readonly AuditWireEntry[]>,
  nowMs: number,
  marginMs: number,
): Promise<{ readonly sinceIso: string | undefined; readonly rows: number }> {
  const mark = await readAuditStoreMark(read, nowMs);
  return { sinceIso: mark.deploymentMs === undefined ? undefined : new Date(mark.deploymentMs - marginMs).toISOString(), rows: mark.rows };
}

export interface SeatContinuity {
  readonly replies: number;
  readonly answeredWakeIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly unattributed: number;
  readonly seatIds: readonly string[];
}

export function seatOfSession(sessionId: string, workerRows: readonly AuditWireEntry[]): string {
  const parentOf = new Map<string, string>();
  for (const r of workerRows) {
    if (r.action !== WORKER_TOOLSET_ACTION) continue;
    const worker = detailString(r, "worker");
    const up = detailString(r, "rootSession") || detailString(r, "parentSession");
    if (worker !== undefined && worker.length > 0 && up !== undefined && up.length > 0 && up !== worker) parentOf.set(worker, up);
  }
  const seen = new Set<string>([sessionId]);
  let current = sessionId;
  for (let next = parentOf.get(current); next !== undefined && !seen.has(next); next = parentOf.get(current)) {
    seen.add(next);
    current = next;
  }
  return current;
}

export type SurfaceScope = string | readonly string[];

export function surfaceScopeList(scope: SurfaceScope): readonly string[] {
  return typeof scope === "string" ? [scope] : scope;
}

function onSurface(r: AuditWireEntry, scope: SurfaceScope | undefined): boolean {
  return scope === undefined || (typeof r.surface === "string" && surfaceScopeList(scope).includes(r.surface));
}

export function seatContinuity(
  rows: readonly AuditWireEntry[],
  opts: { readonly surface?: SurfaceScope; readonly admittedWakeIds?: readonly string[]; readonly workerRows?: readonly AuditWireEntry[] } = {},
): SeatContinuity {
  const admitted = opts.admittedWakeIds;
  const posts = rows.filter((r) => {
    if (r.action !== REPLY_POST_ACTION || !onSurface(r, opts.surface)) return false;
    if (admitted === undefined) return true;
    const wakeId = detailString(r, "wakeId");
    return wakeId !== undefined && wakeId.length > 0 && admitted.includes(wakeId);
  });
  const sessionIds: string[] = [];
  let unattributed = 0;
  for (const r of posts) {
    const id = detailString(r, "sessionId");
    if (id === undefined || id.length === 0) {
      unattributed += 1;
      continue;
    }
    if (!sessionIds.includes(id)) sessionIds.push(id);
  }
  const answeredWakeIds = [...new Set(posts.map((r) => detailString(r, "wakeId")).filter(
    (id): id is string => id !== undefined && id.length > 0,
  ))];
  const seatIds = [...new Set(sessionIds.map((id) => seatOfSession(id, opts.workerRows ?? [])))];
  return { replies: posts.length, sessionIds, unattributed, answeredWakeIds, seatIds };
}

export function wakeIngressIds(rows: readonly AuditWireEntry[], opts: { readonly container?: string } = {}): readonly string[] {
  const ids: string[] = [];
  for (const r of rows) {
    if (r.action !== WAKE_INGRESS_ACTION) continue;
    if (opts.container !== undefined) {
      const key = detailString(r, "surfaceKey");
      if (key === undefined || !namesContainer(key, opts.container)) continue;
    }
    const id = detailString(r, "wakeId");
    if (id === undefined || id.length === 0) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function namesContainer(surfaceKey: string, container: string): boolean {
  if (surfaceKey === container) return true;
  const cut = surfaceKey.lastIndexOf("/");
  return cut >= 0 && surfaceKey.slice(cut + 1) === container;
}

export type EngagedAuditRead = (opts: AuditQueryOpts) => Promise<readonly AuditWireEntry[]>;

export type EngagedWaitBudget = Pick<PollOpts, "timeoutMs" | "what" | "initialDelayMs" | "maxDelayMs">;

export async function awaitReplyPostRows(
  read: EngagedAuditRead,
  opts: {
    readonly sinceIso: string;
    readonly platform: string;
    readonly surface?: string;
    readonly minRows?: number;
    readonly minDistinctWakes?: number;
    readonly budget: EngagedWaitBudget;
  },
): Promise<readonly AuditWireEntry[] | undefined> {
  const scope = opts.surface === undefined ? {} : { surface: opts.surface };
  const minRows = opts.minRows ?? 1;
  return pollOptional(async () => {
    const rows = await read({ sinceIso: opts.sinceIso, platform: opts.platform, actions: [REPLY_POST_ACTION], ...scope });
    return replyPostCount(rows, scope) >= minRows && seatContinuity(rows, scope).answeredWakeIds.length >= (opts.minDistinctWakes ?? 0) ? rows : undefined;
  }, opts.budget);
}

export async function awaitRepliesForAdmittedWakes(
  read: EngagedAuditRead,
  opts: {
    readonly sinceIso: string;
    readonly platform: string;
    readonly surface: SurfaceScope;
    readonly container: string;
    readonly minWakes: number;
    readonly budget: EngagedWaitBudget;
  },
): Promise<{ posts: readonly AuditWireEntry[]; wakeIds: readonly string[] } | undefined> {
  return pollOptional(async () => {
    const query = { sinceIso: opts.sinceIso, platform: opts.platform };
    const [postReads, admissions] = await Promise.all([
      Promise.all(surfaceScopeList(opts.surface).map((surface) => read({ ...query, surface, actions: [REPLY_POST_ACTION] }))),
      read({ ...query, actions: [WAKE_INGRESS_ACTION] }),
    ]);
    const posts = postReads.flat();
    const wakeIds = wakeIngressIds(admissions, { container: opts.container });
    const answered = seatContinuity(posts, { surface: opts.surface, admittedWakeIds: wakeIds });
    return answered.answeredWakeIds.length >= opts.minWakes ? { posts, wakeIds } : undefined;
  }, opts.budget);
}

export async function awaitStandDownVerdict(
  read: EngagedAuditRead,
  opts: {
    readonly sinceIso: string;
    readonly platform: string;
    readonly surface?: string;
    readonly anchor?: string;
    readonly budget: EngagedWaitBudget;
  },
): Promise<readonly AuditWireEntry[]> {
  const join = {
    ...(opts.anchor === undefined ? {} : { anchor: opts.anchor }),
    ...(opts.surface === undefined ? {} : { surface: opts.surface }),
  };
  let last: readonly AuditWireEntry[] = [];
  const found = await pollOptional(async () => {
    last = await read({ sinceIso: opts.sinceIso, platform: opts.platform, actions: [STOOD_DOWN_ACTION] });
    return standDownMarked(last, join) || standDownAttemptedButUnmarked(last, join) ? last : undefined;
  }, opts.budget);
  return found ?? last;
}
