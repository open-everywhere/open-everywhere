import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, channelPlatform, type BindableContext } from "../identity/binding.js";
import { STOP_HAND_SLACK_NAME, STOP_HAND_UNICODE } from "../status/status.js";
import { setSurfaceReaction } from "../channels/surface-message-ops.js";
import { postSurfaceText } from "../channels/surface-message-ops.js";
import { clearTurnAnchor, recordTurnAnchor, turnAnchorKey, turnChannelKey } from "../channels/turn-registry.js";
import { attachCancelNoteRequester, clearPendingCancelNoteAfter, setPendingCancelNote } from "../channels/cancel-note.js";
import { findCancelRequester } from "../channels/turn-cancel.js";
import { forgetBridgedQuestion } from "../channels/question-bridge.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { isSupervisorToken, standingSeatRegistryKey } from "../channels/unified-supervisor.js";
import { seedTailWindow } from "../channels/session-tail-record.js";
import { domainKeyOf } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import { closeTurnTally, openTurnTally, readTurnTally, recordTallyAction, recordTallyHand, recordTallyStep } from "./turn-tally.js";

export const TURN_CANCELLED_ACTION = "turn.cancelled";

const MAX_NAMED_ACTIONS = 3;

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

function isDelegation(action: { readonly kind: string; readonly toolName?: string }): boolean {
  return action.kind === "subagent-call" || (action.kind === "tool-call" && action.toolName === "agent");
}

const STOP_HAND = { slackName: STOP_HAND_SLACK_NAME, unicode: STOP_HAND_UNICODE } as const;

async function onTurnStarted(turnId: string, ctx: HookContext): Promise<void> {
  const c = ctx as unknown as BindableContext;
  const partition = resolvePartition(c);
  const binding = bindFrom(c);
  const platform = channelPlatform(c) ?? binding.platform;
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  const messageId = binding.threadTs ?? binding.anchorMessageId;
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

  if (read()?.turnId === turnId) openTurnTally(ctx.session.id, turnId);

  const tailToken = bareTokenFromEveContext(ctx.channel?.continuationToken);
  seedTailWindow(
    tailToken !== undefined && isSupervisorToken(tailToken)
      ? {
          org: partition.org,
          registryKey: standingSeatRegistryKey(tailToken, domainKeyOf(partition)) ?? domainKeyOf(partition),
          token: tailToken,
          ...(platform ? { platform } : {}),
          container: partition.surfaceKey,
        }
      : null,
  );

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
  if (!accounted) return "Stood down. I cannot say how far in it was — the cancel discarded that record. Anything already done is NOT undone.";
  const where = steps === 1 ? "one step in" : `${steps} steps in`;
  if (ran.length === 0) return `Stood down — ${where}, nothing had run yet.`;
  const named = ran.slice(-MAX_NAMED_ACTIONS);
  const more = ran.length - named.length;
  const list = named.map((n) => `\`${n}\``).join(", ");
  const tail = more > 0 ? ` (and ${more} earlier)` : "";
  return `Stood down — ${where}. Already done, and NOT undone: ${list}${tail}.`;
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
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    const messageId = binding.threadTs ?? binding.anchorMessageId;
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
  if (live && live.turnId !== turnId) {
    closeTurnTally(live.sessionId, turnId);
    return;
  }
  const addressing = live ?? reconstructCancelledTurn(turnId, ctx);
  if (!addressing) return;
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

  const by = await findCancelRequester(s.org, turnId);
  if (by) attachCancelNoteRequester(turnId, by);

  try {
    await appendAudit({
      org: s.org,
      platform: s.platform ?? "unknown",
      workspace: s.workspace,
      action: TURN_CANCELLED_ACTION,
      detail: s.accounted
        ? { surfaceKey: s.surfaceKey, steps: s.steps, ran: s.ran, accounted: true }
        : { surfaceKey: s.surfaceKey, accounted: false },
    });
  } catch {
  }
  write(null);
}

async function onTurnEnded(turnId: string, ctx?: HookContext): Promise<void> {
  clearPendingCancelNoteAfter(turnId);
  const s = read();
  const sessionId = s?.sessionId ?? ctx?.session.id;
  const tally = sessionId === undefined ? null : readTurnTally(sessionId, turnId);
  if (sessionId !== undefined) closeTurnTally(sessionId, turnId);
  if (!s || s.turnId !== turnId) return;
  await removeStopHand(tally ? { ...s, handPlaced: tally.handPlaced } : s);
  await clearTurnAnchor(s.org, s.windowKey);
  write(null);
}

export default defineHook({
  events: {
    "turn.started": async (event, ctx: HookContext) => {
      try {
        await onTurnStarted(event.data.turnId, ctx);
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.started failed: ${String(err)}`);
      }
    },
    "actions.requested": async (event) => {
      try {
        if (event.data.actions.some((a) => isDelegation(a as { kind: string; toolName?: string }))) await placeStopHand();
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
        await onTurnEnded(event.data.turnId, ctx);
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.completed failed: ${String(err)}`);
      }
    },
    "turn.failed": async (event, ctx: HookContext) => {
      try {
        await onTurnEnded(event.data.turnId, ctx);
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
  },
});
