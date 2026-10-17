import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { appendAudit, readAudit } from "../audit/audit.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, channelPlatform, currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { isWorkSessionChildContext, isWorkSessionContext } from "../access/work-session.js";
import { STOP_HAND_SLACK_NAME, STOP_HAND_UNICODE } from "../status/status.js";
import { setSurfaceReaction } from "../channels/surface-message-ops.js";
import { postSurfaceText } from "../channels/surface-message-ops.js";
import { clearTurnAnchor, recordTurnAnchor, turnAnchorAddress, turnAnchorKey, turnChannelKey } from "../channels/turn-registry.js";
import { attachCancelNoteRequester, clearPendingCancelNoteAfter, readPendingCancelNote, setPendingCancelNote } from "../channels/cancel-note.js";
import { findCancelRequest, findCancelRequester, TURN_CANCELLED_ACTION, TURN_STOP_IGNORED_ACTION, type CancelRequestRecord } from "../channels/turn-cancel.js";
import { forgetBridgedQuestion } from "../channels/question-bridge.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { seedTailWindow, tailWindowFor } from "../channels/session-tail-record.js";
import { domainKeyOf } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import { uningressedTurn } from "../access/task-wake-signal.js";
import { markSurfaceSession, parkedSurfaceStatus, pinSurfaceSession, surfaceTurnOf } from "../channels/surface-session-state.js";
import { conversationHasWaitingJob } from "../channels/work-surface-wait.js";
import { resetSessionAttention, sessionNeedsPerson } from "../status/attention.js";
import { closeTurnTally, openTurnTally, readTurnTally, recordTallyAction, recordTallyHand, recordTallyStep } from "./turn-tally.js";

export { TURN_CANCELLED_ACTION, TURN_STOP_IGNORED_ACTION };

export const IGNORED_STOP_NOTE = "The stop did not take effect — this turn ended on its own before the cancel reached it. Nothing was interrupted.";

const CANCEL_SETTLE_GRACE_MS = 10_000;

let cancelSettleGraceMs = CANCEL_SETTLE_GRACE_MS;

export function __setCancelSettleGraceForTest(ms?: number): void {
  cancelSettleGraceMs = ms ?? CANCEL_SETTLE_GRACE_MS;
}

const SETTLED_CANCELS = new Map<string, number>();

export function __clearSettledCancelsForTest(): void {
  SETTLED_CANCELS.clear();
}

const settledKey = (sessionId: string, turnId: string): string => `${sessionId}\u0000${turnId}`;

const PENDING_IGNORED_STOPS = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number; resolve: () => Promise<void> }>();

async function drainDueIgnoredStops(): Promise<void> {
  const now = Date.now();
  const due = [...PENDING_IGNORED_STOPS.entries()].filter(([, entry]) => entry.dueAt <= now);
  for (const [key, entry] of due) {
    clearTimeout(entry.timer);
    PENDING_IGNORED_STOPS.delete(key);
  }
  await Promise.all(due.map(([, entry]) => entry.resolve()));
}

export async function __flushIgnoredStopChecksForTest(): Promise<void> {
  const pending = [...PENDING_IGNORED_STOPS.values()];
  PENDING_IGNORED_STOPS.clear();
  for (const entry of pending) clearTimeout(entry.timer);
  await Promise.all(pending.map((entry) => entry.resolve()));
}

export function __pendingIgnoredStopCountForTest(): number {
  return PENDING_IGNORED_STOPS.size;
}

function dropPendingIgnoredStop(sessionId: string, turnId: string): void {
  const key = settledKey(sessionId, turnId);
  const entry = PENDING_IGNORED_STOPS.get(key);
  if (entry === undefined) return;
  clearTimeout(entry.timer);
  PENDING_IGNORED_STOPS.delete(key);
}

function markCancelSettled(sessionId: string, turnId: string): void {
  const cutoff = Date.now() - 10 * Math.max(cancelSettleGraceMs, CANCEL_SETTLE_GRACE_MS);
  for (const [key, at] of SETTLED_CANCELS) if (at < cutoff) SETTLED_CANCELS.delete(key);
  SETTLED_CANCELS.set(settledKey(sessionId, turnId), Date.now());
  dropPendingIgnoredStop(sessionId, turnId);
}

const ENDED_TURNS = new Map<string, { at: number; stopRequested?: boolean }>();

export function __clearEndedTurnsForTest(): void {
  ENDED_TURNS.clear();
}

function markTurnEnded(sessionId: string, turnId: string): void {
  const cutoff = Date.now() - 10 * Math.max(cancelSettleGraceMs, CANCEL_SETTLE_GRACE_MS);
  for (const [key, at] of ENDED_TURNS) if (at.at < cutoff) ENDED_TURNS.delete(key);
  ENDED_TURNS.set(settledKey(sessionId, turnId), { at: Date.now() });
}

function recordEndedTurnStopAnswer(sessionId: string, turnId: string, stopRequested: boolean): void {
  const entry = ENDED_TURNS.get(settledKey(sessionId, turnId));
  if (entry) entry.stopRequested = stopRequested;
}

function endedWithNoStopRequested(sessionId: string, turnId: string): boolean {
  return ENDED_TURNS.get(settledKey(sessionId, turnId))?.stopRequested === false;
}

interface TurnAnchorState {
  readonly turnId: string;
  readonly sessionId: string;
  readonly org: string;
  readonly windowKey: string;
  readonly platform?: string;
  readonly channelId?: string;
  readonly messageId?: string;
  readonly workspace: string;
  readonly surfaceKey: string;
  handPlaced: boolean;
  ran: string[];
  steps: number;
}

const slot = defineState<TurnAnchorState | null>("open-everywhere.turn-anchor", () => null);

function read(): TurnAnchorState | null {
  try {
    return slot.get();
  } catch {
    return null;
  }
}

function write(next: TurnAnchorState | null): void {
  try {
    slot.update(() => next);
  } catch {
  }
}

function mutate(fn: (s: TurnAnchorState) => void): void {
  try {
    slot.update((prev) => {
      if (prev) fn(prev);
      return prev;
    });
  } catch {
  }
}

function isDelegation(action: { readonly kind: string }): boolean {
  return action.kind === "subagent-call";
}

const STOP_HAND = { slackName: STOP_HAND_SLACK_NAME, unicode: STOP_HAND_UNICODE } as const;
async function onTurnStarted(turnId: string, ctx: HookContext): Promise<void> {
  const c = ctx as unknown as BindableContext;
  const partition = resolvePartition(c);
  const binding = bindFrom(c);
  const platform = channelPlatform(c) ?? binding.platform;
  const { channelId, messageId } = turnAnchorAddress(binding);
  const windowKey = ctx.channel?.continuationToken ?? ctx.session.id;

  write({
    turnId,
    sessionId: ctx.session.id,
    org: partition.org,
    windowKey,
    ...(platform ? { platform } : {}),
    ...(channelId ? { channelId } : {}),
    ...(messageId ? { messageId } : {}),
    workspace: partition.workspace,
    surfaceKey: partition.surfaceKey,
    handPlaced: false,
    ran: [],
    steps: 0,
  });

  if (read()?.turnId === turnId) openTurnTally(ctx.session.id, turnId, currentWakeId(c));

  seedTailWindow(
    tailWindowFor({
      org: partition.org,
      domainKey: domainKeyOf(partition),
      surfaceKey: partition.surfaceKey,
      rawToken: ctx.channel?.continuationToken,
      ...(platform ? { platform } : {}),
    }),
  );

  if (!turnAnchorRecordable(c)) return;
  await recordTurnAnchor(
    partition.org,
    {
      windowKey,
      ...(turnAnchorKey(platform, channelId, messageId) ? { anchorKey: turnAnchorKey(platform, channelId, messageId)! } : {}),
      ...(turnChannelKey(platform, channelId) ? { channelKey: turnChannelKey(platform, channelId)! } : {}),
      sessionId: ctx.session.id,
      turnId,
      surfaceKey: partition.surfaceKey,
    },
    new Date().toISOString(),
  );
}

export function turnAnchorRecordable(ctx: BindableContext): boolean {
  return !isWorkSessionChildContext(ctx);
}

async function placeStopHand(): Promise<void> {
  const s = read();
  if (!s || s.handPlaced || !s.platform || !s.channelId || !s.messageId) return;
  mutate((st) => {
    st.handPlaced = true;
  });
  recordTallyHand(s.sessionId, s.turnId, true);
  const landed = await setSurfaceReaction(s.platform, { channelId: s.channelId, messageId: s.messageId }, STOP_HAND, true);
  if (!landed) {
    mutate((st) => {
      st.handPlaced = false;
    });
    recordTallyHand(s.sessionId, s.turnId, false);
  }
}

async function removeStopHand(s: TurnAnchorState): Promise<void> {
  if (!s.handPlaced || !s.platform || !s.channelId || !s.messageId) return;
  await setSurfaceReaction(s.platform, { channelId: s.channelId, messageId: s.messageId }, STOP_HAND, false);
}

export function renderCancelNote(steps: number, ran: readonly string[], accounted = true): string {
  if (!accounted) return CANCEL_NOTE_UNACCOUNTED;
  const where = steps === 1 ? "one step in" : `${steps} steps in`;
  if (ran.length === 0) return `Stood down — ${where}, nothing had run yet.`;
  const done = ran.length === 1 ? "One action had already run, and it is" : `${ran.length} actions had already run, and they are`;
  return `Stood down — ${where}. ${done} NOT undone.`;
}

const CANCEL_NOTE_UNACCOUNTED =
  "Stood down. I cannot say how far in it was — the cancel discarded that record. Anything already done is NOT undone.";

const CANCEL_NOTE_ACCOUNTED =
  /^Stood down — (?:one step in|\d+ steps in)(?:, nothing had run yet\.|\. (?:One action had already run, and it is|\d+ actions had already run, and they are) NOT undone\.)$/;

export function isTurnCancelNote(text: string): boolean {
  const t = text.trim();
  return t === CANCEL_NOTE_UNACCOUNTED || CANCEL_NOTE_ACCOUNTED.test(t);
}

interface CancelledTurnFacts extends TurnAnchorState {
  readonly accounted: boolean;
}

function reconstructCancelledTurn(turnId: string, ctx: HookContext | undefined): TurnAnchorState | null {
  if (ctx === undefined) return null;
  try {
    const c = ctx as unknown as BindableContext;
    const partition = resolvePartition(c);
    const binding = bindFrom(c);
    const platform = channelPlatform(c) ?? binding.platform;
    const { channelId, messageId } = turnAnchorAddress(binding);
    const windowKey = ctx.channel?.continuationToken ?? ctx.session.id;
    return {
      turnId,
      sessionId: ctx.session.id,
      org: partition.org,
      windowKey,
      ...(platform ? { platform } : {}),
      ...(channelId ? { channelId } : {}),
      ...(messageId ? { messageId } : {}),
      workspace: partition.workspace,
      surfaceKey: partition.surfaceKey,
      handPlaced: false,
      ran: [],
      steps: 0,
    };
  } catch {
    return null;
  }
}

async function onTurnCancelled(turnId: string, ctx?: HookContext): Promise<void> {
  const live = read();
  for (const sessionId of new Set([live?.sessionId, ctx?.session.id])) {
    if (sessionId !== undefined) markCancelSettled(sessionId, turnId);
  }
  if (live && live.turnId !== turnId) {
    closeTurnTally(live.sessionId, turnId);
    return;
  }
  const addressing = live ?? reconstructCancelledTurn(turnId, ctx);
  if (!addressing) return;
  if (endedWithNoStopRequested(addressing.sessionId, turnId)) {
    closeTurnTally(addressing.sessionId, turnId);
    const orphaned = bareTokenFromEveContext(addressing.windowKey);
    if (orphaned !== undefined) await forgetBridgedQuestion(getOperationalStore(), addressing.org, orphaned);
    return;
  }
  const tally = readTurnTally(addressing.sessionId, turnId);
  const s: CancelledTurnFacts = tally
    ? { ...addressing, handPlaced: tally.handPlaced, ran: [...tally.ran], steps: tally.steps, accounted: true }
    : { ...addressing, accounted: live !== null };
  closeTurnTally(addressing.sessionId, turnId);
  setPendingCancelNote({ turnId, steps: s.steps, ran: [...s.ran], accounted: s.accounted });
  await removeStopHand(s);
  await clearTurnAnchor(s.org, s.windowKey);
  const bare = bareTokenFromEveContext(s.windowKey);
  if (bare !== undefined) await forgetBridgedQuestion(getOperationalStore(), s.org, bare);

  const note = renderCancelNote(s.steps, s.ran, s.accounted);
  if (s.platform && s.channelId) {
    await postSurfaceText(s.platform, { channelId: s.channelId, text: note, threadTs: s.messageId ?? null });
  }

  const by = await findCancelRequester(s.org, turnId, s.sessionId);
  if (by) attachCancelNoteRequester(turnId, by);

  try {
    await appendAudit({
      org: s.org,
      platform: s.platform ?? "unknown",
      workspace: s.workspace,
      action: TURN_CANCELLED_ACTION,
      detail: s.accounted
        ? { surfaceKey: s.surfaceKey, sessionId: s.sessionId, turnId, steps: s.steps, ran: s.ran, accounted: true }
        : { surfaceKey: s.surfaceKey, sessionId: s.sessionId, turnId, accounted: false },
    });
  } catch {
  }
  write(null);
}

async function pairedRowExists(org: string, action: string, sessionId: string, turnId: string, endedAt: number): Promise<boolean> {
  const since = new Date(Math.min(Date.now(), endedAt) - 4 * CANCEL_SETTLE_GRACE_MS).toISOString();
  const rows = await readAudit({ org, action, since, limit: 50 });
  return rows.some((row) => row.detail?.["turnId"] === turnId && row.detail?.["sessionId"] === sessionId);
}

async function auditIgnoredStop(s: TurnAnchorState, turnId: string, endedAs: "completed" | "failed"): Promise<boolean> {
  const request = await findCancelRequest({ org: s.org, turnId, sessionId: s.sessionId });
  if (request?.outcome !== "requested") return false;
  const key = settledKey(s.sessionId, turnId);
  if (PENDING_IGNORED_STOPS.has(key)) return true;
  const endedAt = Date.now();
  const resolve = async (): Promise<void> => {
    PENDING_IGNORED_STOPS.delete(key);
    try {
      await writeIgnoredStop(s, turnId, endedAs, request, endedAt);
    } catch (err) {
      console.error(
        `[open-everywhere:turn-anchor] 🔴 the ignored-stop check FAILED for turn ${turnId}: ${String(err)} — a stop was accepted for this turn and its ${TURN_STOP_IGNORED_ACTION} record may be incomplete (the row, the room note, or both)`,
      );
    }
  };
  const timer = setTimeout(() => void resolve(), cancelSettleGraceMs);
  PENDING_IGNORED_STOPS.set(key, { timer, dueAt: endedAt + cancelSettleGraceMs, resolve });
  return true;
}

async function writeIgnoredStop(s: TurnAnchorState, turnId: string, endedAs: "completed" | "failed", request: CancelRequestRecord, endedAt: number): Promise<void> {
  if (SETTLED_CANCELS.has(settledKey(s.sessionId, turnId))) return;
  if (await pairedRowExists(s.org, TURN_CANCELLED_ACTION, s.sessionId, turnId, endedAt)) return;
  if (await pairedRowExists(s.org, TURN_STOP_IGNORED_ACTION, s.sessionId, turnId, endedAt)) return;
  await appendAudit({
    org: s.org,
    platform: s.platform ?? "unknown",
    workspace: s.workspace,
    action: TURN_STOP_IGNORED_ACTION,
    ...(request.principalId ? { principalId: request.principalId } : {}),
    detail: {
      surfaceKey: s.surfaceKey,
      sessionId: s.sessionId,
      turnId,
      endedAs,
      ...(request.via ? { via: request.via } : {}),
      ...(request.at ? { requestedAt: request.at } : {}),
    },
  });
  if (s.platform && s.channelId) {
    await postSurfaceText(s.platform, { channelId: s.channelId, text: IGNORED_STOP_NOTE, threadTs: s.messageId ?? null });
  }
}

async function endedTurnWasAttended(turnId: string, wakeId: string | undefined): Promise<boolean> {
  if (readPendingCancelNote() === null) return true;
  if (wakeId === undefined || wakeId.length === 0) return !uningressedTurn(turnId);
  try {
    const record = await getOperationalStore().getUnifiedWakeRecord(deploymentOrg(), wakeId);
    return record?.inbound !== false;
  } catch {
    return true;
  }
}

async function onTurnEnded(turnId: string, ctx: HookContext | undefined, endedAs: "completed" | "failed"): Promise<void> {
  const s = read();
  for (const id of new Set([s?.sessionId, ctx?.session.id])) if (id !== undefined) markTurnEnded(id, turnId);
  const sessionId = s?.sessionId ?? ctx?.session.id;
  const tally = sessionId === undefined ? null : readTurnTally(sessionId, turnId);
  clearPendingCancelNoteAfter(turnId, await endedTurnWasAttended(turnId, tally?.wakeId));
  if (sessionId !== undefined) closeTurnTally(sessionId, turnId);
  const live = s && s.turnId === turnId ? s : null;
  if (live) {
    await removeStopHand(tally ? { ...live, handPlaced: tally.handPlaced } : live);
    await clearTurnAnchor(live.org, live.windowKey);
    write(null);
  }
  const addressing = live ?? reconstructCancelledTurn(turnId, ctx);
  if (!addressing) return;
  try {
    const stopRequested = await auditIgnoredStop(addressing, turnId, endedAs);
    for (const id of new Set([s?.sessionId, ctx?.session.id, addressing.sessionId])) if (id !== undefined) recordEndedTurnStopAnswer(id, turnId, stopRequested);
  } catch (err) {
    console.error(
      `[open-everywhere:turn-anchor] 🔴 the ignored-stop check FAILED for turn ${turnId}: ${String(err)} — if a stop was accepted for this turn, NO ${TURN_STOP_IGNORED_ACTION} row was written for it`,
    );
  }
}

const startedSurfaceSession = defineState<{ readonly platform: string; readonly id: string; readonly attributes: Readonly<Record<string, unknown>> } | null>(
  "open-everywhere.turn-anchor.surface-session",
  () => null,
);

async function startTurnSession(ctx: HookContext): Promise<void> {
  const turn = surfaceTurnOf(ctx);
  if (!turn) return;
  resetSessionAttention();
  const id = await markSurfaceSession(turn.platform, turn.attributes, "processing");
  try {
    startedSurfaceSession.update(() => (id === undefined ? null : { ...turn, id }));
  } catch {
  }
}

async function parkTurnSession(ctx: HookContext): Promise<void> {
  const turn = surfaceTurnOf(ctx);
  if (!turn) return;
  const needsPerson = sessionNeedsPerson();
  const status = parkedSurfaceStatus(needsPerson || (await conversationHasWaitingJob(pinSurfaceSession(turn))));
  const parkedId = await markSurfaceSession(turn.platform, turn.attributes, status);
  let started: { readonly platform: string; readonly id: string; readonly attributes: Readonly<Record<string, unknown>> } | null = null;
  try {
    started = startedSurfaceSession.get();
    if (started !== null) startedSurfaceSession.update(() => null);
  } catch {
    return;
  }
  if (started === null) return;
  if (started.platform === turn.platform && started.id === parkedId) return;
  const startedStatus = parkedSurfaceStatus(needsPerson || (await conversationHasWaitingJob(pinSurfaceSession({ platform: started.platform, attributes: started.attributes }))));
  await markSurfaceSession(started.platform, started.attributes, startedStatus);
}

export default defineHook({
  events: {
    "turn.started": async (event, ctx: HookContext) => {
      try {
        await onTurnStarted(event.data.turnId, ctx);
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.started failed: ${String(err)}`);
      }
      await startTurnSession(ctx);
      try {
        await drainDueIgnoredStops();
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] ignored-stop drain failed: ${String(err)}`);
      }
    },
    "actions.requested": async (event, ctx) => {
      try {
        if (!turnAnchorRecordable(ctx as unknown as BindableContext)) return;
        if (isWorkSessionContext(ctx as unknown as BindableContext)) return;
        if (event.data.actions.some((a) => isDelegation(a as { kind: string }))) await placeStopHand();
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] actions.requested failed: ${String(err)}`);
      }
    },
    "action.result": async (event) => {
      try {
        const result = event.data.result as { kind?: string; toolName?: string };
        if (result?.kind === "tool-result" && event.data.status !== "rejected" && typeof result.toolName === "string") {
          const name = result.toolName;
          const s = read();
          if (s) recordTallyAction(s.sessionId, s.turnId, name);
          mutate((st) => {
            st.ran.push(name);
          });
        }
      } catch {
      }
    },
    "step.completed": async () => {
      try {
        const s = read();
        if (s) recordTallyStep(s.sessionId, s.turnId);
        mutate((st) => {
          st.steps += 1;
        });
      } catch {
      }
    },
    "turn.completed": async (event, ctx: HookContext) => {
      try {
        await onTurnEnded(event.data.turnId, ctx, "completed");
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.completed failed: ${String(err)}`);
      }
    },
    "turn.failed": async (event, ctx: HookContext) => {
      try {
        await onTurnEnded(event.data.turnId, ctx, "failed");
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.failed failed: ${String(err)}`);
      }
    },
    "turn.cancelled": async (event, ctx: HookContext) => {
      try {
        await onTurnCancelled(event.data.turnId, ctx);
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.cancelled failed: ${String(err)}`);
      }
    },
    "session.waiting": async (_event, ctx: HookContext) => {
      await parkTurnSession(ctx);
      try {
        await drainDueIgnoredStops();
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] ignored-stop drain failed: ${String(err)}`);
      }
    },
    "session.completed": async () => {
      try {
        await drainDueIgnoredStops();
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] ignored-stop drain failed: ${String(err)}`);
      }
    },
    "session.failed": async () => {
      try {
        await drainDueIgnoredStops();
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] ignored-stop drain failed: ${String(err)}`);
      }
    },
  },
});
