import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, channelPlatform, type BindableContext } from "../identity/binding.js";
import { STOP_HAND_SLACK_NAME, STOP_HAND_UNICODE } from "../status/status.js";
import { setSurfaceReaction } from "../channels/surface-message-ops.js";
import { postSurfaceText } from "../channels/surface-message-ops.js";
import { clearTurnAnchor, recordTurnAnchor, turnAnchorKey, turnChannelKey } from "../channels/turn-registry.js";

export const TURN_CANCELLED_ACTION = "turn.cancelled";

const MAX_NAMED_ACTIONS = 3;

interface TurnAnchorState {
  readonly turnId: string;
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
  const messageId = binding.threadTs;
  const windowKey = ctx.channel?.continuationToken ?? ctx.session.id;

  write({
    turnId,
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
  const landed = await setSurfaceReaction(s.platform, { channelId: s.channelId, messageId: s.messageId }, STOP_HAND, true);
  if (!landed) {
    mutate((st) => {
      st.handPlaced = false;
    });
  }
}

async function removeStopHand(s: TurnAnchorState): Promise<void> {
  if (!s.handPlaced || !s.platform || !s.channelId || !s.messageId) return;
  await setSurfaceReaction(s.platform, { channelId: s.channelId, messageId: s.messageId }, STOP_HAND, false);
}

export function renderCancelNote(steps: number, ran: readonly string[]): string {
  const where = steps === 1 ? "one step in" : `${steps} steps in`;
  if (ran.length === 0) return `Stood down — ${where}, nothing had run yet.`;
  const named = ran.slice(-MAX_NAMED_ACTIONS);
  const more = ran.length - named.length;
  const list = named.map((n) => `\`${n}\``).join(", ");
  const tail = more > 0 ? ` (and ${more} earlier)` : "";
  return `Stood down — ${where}. Already done, and NOT undone: ${list}${tail}.`;
}

async function onTurnCancelled(turnId: string): Promise<void> {
  const s = read();
  if (!s || s.turnId !== turnId) return;
  await removeStopHand(s);
  await clearTurnAnchor(s.org, s.windowKey);

  const note = renderCancelNote(s.steps, s.ran);
  if (s.platform && s.channelId) {
    await postSurfaceText(s.platform, { channelId: s.channelId, text: note, threadTs: s.messageId ?? null });
  }
  try {
    await appendAudit({
      org: s.org,
      platform: s.platform ?? "unknown",
      workspace: s.workspace,
      action: TURN_CANCELLED_ACTION,
      detail: { surfaceKey: s.surfaceKey, steps: s.steps, ran: s.ran },
    });
  } catch {
  }
  write(null);
}

async function onTurnEnded(turnId: string): Promise<void> {
  const s = read();
  if (!s || s.turnId !== turnId) return;
  await removeStopHand(s);
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
          mutate((st) => {
            st.ran.push(name);
          });
        }
      } catch {
      }
    },
    "step.completed": async () => {
      try {
        mutate((st) => {
          st.steps += 1;
        });
      } catch {
      }
    },
    "turn.completed": async (event) => {
      try {
        await onTurnEnded(event.data.turnId);
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.completed failed: ${String(err)}`);
      }
    },
    "turn.failed": async (event) => {
      try {
        await onTurnEnded(event.data.turnId);
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.failed failed: ${String(err)}`);
      }
    },
    "turn.cancelled": async (event) => {
      try {
        await onTurnCancelled(event.data.turnId);
      } catch (err) {
        console.warn(`[open-everywhere:turn-anchor] turn.cancelled failed: ${String(err)}`);
      }
    },
  },
});
