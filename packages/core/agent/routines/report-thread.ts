import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { appendAudit } from "../audit/audit.js";
import { parseScopeKey } from "../access/scope-key.js";
import { isThreadScopedWakeOrigin, isUnifiedWakeOrigin, unifiedThreadRef, type UnifiedThreadRef, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { wakeOriginCodec } from "../channels/wake-origin-codec.js";
import { workRequestIdFor } from "../channels/work.js";
import { postArm } from "../channels/post-arms.js";
import type { ReplyTarget } from "../channels/reply-post.js";
import { triggerAuthors } from "../channels/wake-envelope.js";
import { getRoutine, updateRoutineIf } from "./store.js";
import { attentionResetPatch, attentionRuns, ROUTINE_CHECKIN_ACTION } from "./attention.js";

export const REPORT_THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReplyRoutine {
  readonly surfaceKey: string;
  readonly id: string;
  readonly requestId: string;
}

export const MEMBER_TIERS: ReadonlySet<string> = new Set(["principal", "peer"]);

export function vouchedReplier(text: string, principalId: string): string | undefined {
  const mine = triggerAuthors(text).filter((a) => a.from === "human" && a.authorId === principalId);
  return mine.length > 0 && mine.every((a) => a.trust !== undefined && MEMBER_TIERS.has(a.trust)) ? principalId : undefined;
}

export function reportRoutineOf(routine: ReplyRoutine | undefined, wakeId: string | undefined): ReplyRoutine | undefined {
  if (routine === undefined || wakeId === undefined || wakeId.length === 0) return undefined;
  return workRequestIdFor(`fire:${wakeId}`) === routine.requestId ? routine : undefined;
}

export function reportReplyThreads(origin: UnifiedWakeOrigin, messageId: string): UnifiedThreadRef[] {
  const refs: UnifiedThreadRef[] = [];
  const codec = wakeOriginCodec(origin.platform);
  if (codec === undefined) return refs;
  if (isThreadScopedWakeOrigin(origin)) refs.push(unifiedThreadRef(origin));
  const under = messageId.length > 0 ? codec.replyThreadUnder?.(origin, messageId) : undefined;
  if (under !== undefined && isUnifiedWakeOrigin(under) && under.platform === origin.platform && isThreadScopedWakeOrigin(under)) {
    const ref = unifiedThreadRef(under);
    if (!refs.some((r) => r.channelKey === ref.channelKey && r.threadKey === ref.threadKey)) refs.push(ref);
  }
  return refs;
}

export function originOfReplyTarget(target: ReplyTarget): UnifiedWakeOrigin | undefined {
  try {
    const origin = postArm(target.platform)?.originOfTarget?.(target);
    return origin !== undefined && isUnifiedWakeOrigin(origin) && origin.platform === target.platform ? origin : undefined;
  } catch {
    return undefined;
  }
}

export async function recordNativeReportThreads(
  input: { readonly org: string | undefined; readonly target: ReplyTarget; readonly messageId: string; readonly routine: Pick<ReplyRoutine, "id" | "surfaceKey">; readonly now?: Date },
  store?: Pick<OperationalStore, "putRoutineReportThread">,
): Promise<number> {
  const origin = originOfReplyTarget(input.target);
  if (origin === undefined) return 0;
  return recordRoutineReportThreads({ org: input.org, origin, messageId: input.messageId, routine: input.routine, ...(input.now !== undefined ? { now: input.now } : {}) }, store);
}

export async function recordRoutineReportThreads(
  input: { readonly org: string | undefined; readonly origin: UnifiedWakeOrigin; readonly messageId: string; readonly routine: Pick<ReplyRoutine, "id" | "surfaceKey">; readonly now?: Date },
  store?: Pick<OperationalStore, "putRoutineReportThread">,
): Promise<number> {
  if (input.org === undefined) return 0;
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + REPORT_THREAD_TTL_MS).toISOString();
  let written = 0;
  try {
    const rows = store ?? getOperationalStore();
    for (const ref of reportReplyThreads(input.origin, input.messageId)) {
      await rows.putRoutineReportThread(input.org, { ...ref, routineSurface: input.routine.surfaceKey, routineId: input.routine.id }, at, expiresAt);
      written += 1;
    }
  } catch (err) {
    console.warn(`[open-everywhere:routines] could not record a report thread: ${err instanceof Error ? err.message : String(err)}`);
  }
  return written;
}

export interface ReportReplyDeps {
  readonly store: Pick<OperationalStore, "getRoutineReportThread">;
  readonly getRoutine: typeof getRoutine;
  readonly updateRoutineIf: typeof updateRoutineIf;
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
  readonly now: () => Date;
}

export function liveReportReplyDeps(): ReportReplyDeps {
  return { store: getOperationalStore(), getRoutine, updateRoutineIf, audit: appendAudit, now: () => new Date() };
}

export type ReportReplyOutcome = "not-a-thread" | "no-report" | "gone" | "not-active" | "nothing-to-clear" | "checked-in" | "error";

function whereOf(org: string, surfaceKey: string): { org: string; platform: string; workspace: string; surface?: string } {
  const parsed = parseScopeKey(surfaceKey);
  return parsed.kind === "surface" ? { org, platform: parsed.platform, workspace: parsed.workspace, surface: parsed.surface } : { org, platform: "routine", workspace: "unknown" };
}

export async function checkInFromReportReply(
  input: { readonly org: string; readonly origin: UnifiedWakeOrigin; readonly principalId: string },
  injected?: ReportReplyDeps,
): Promise<ReportReplyOutcome> {
  try {
    const deps = injected ?? liveReportReplyDeps();
    if (!isThreadScopedWakeOrigin(input.origin)) return "not-a-thread";
    const ref = unifiedThreadRef(input.origin);
    const row = await deps.store.getRoutineReportThread(input.org, ref.channelKey, ref.threadKey, deps.now().toISOString());
    if (row === null) return "no-report";
    const live = await deps.getRoutine(input.org, row.routineSurface, row.routineId);
    if (live === null) return "gone";
    if (live.status !== "active") return "not-active";
    if (live.attention === undefined) return "nothing-to-clear";
    let runs = 0;
    const written = await deps.updateRoutineIf(
      input.org,
      row.routineSurface,
      row.routineId,
      (r) => r.status === "active" && r.attention !== undefined,
      (r) => {
        runs = attentionRuns(r);
        return attentionResetPatch();
      },
    );
    if (written.kind === "gone") return "gone";
    if (written.kind === "refused") return written.routine.status !== "active" ? "not-active" : "nothing-to-clear";
    await deps
      .audit({ ...whereOf(input.org, row.routineSurface), principalId: input.principalId, action: ROUTINE_CHECKIN_ACTION, detail: { id: row.routineId, via: "reply", resumed: false, runs } })
      .catch(() => undefined);
    return "checked-in";
  } catch (err) {
    console.warn(`[open-everywhere:routines] could not read a report thread: ${err instanceof Error ? err.message : String(err)}`);
    return "error";
  }
}
