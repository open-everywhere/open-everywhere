import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";
import { readModelStamp } from "../model/model-stamp.js";
import { emitTelemetry, flushTelemetry, maybeHeartbeat, tokensBucket, stepsBucket, latencyBucket } from "../observability/telemetry.js";

interface TurnAccumulator {
  readonly turnId: string;
  readonly startedAt: number;
  steps: number;
  tokens: number;
}

const turnSlot = defineState<TurnAccumulator | null>("open-everywhere.telemetry-turn", () => null);

function readTurn(): TurnAccumulator | null {
  try {
    return turnSlot.get();
  } catch {
    return null;
  }
}

function resetTurn(turnId: string, startedAt: number): void {
  try {
    turnSlot.update(() => ({ turnId, startedAt, steps: 0, tokens: 0 }));
  } catch {
  }
}

function bumpTurn(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined): void {
  try {
    turnSlot.update((prev) => {
      const base = prev ?? { turnId: "", startedAt: Date.now(), steps: 0, tokens: 0 };
      const delta = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
      return { ...base, steps: base.steps + 1, tokens: base.tokens + delta };
    });
  } catch {
  }
}

function isWebhookFire(ctx: BindableContext): boolean {
  const attrs = ctx.session?.auth?.current?.attributes ?? ctx.session?.auth?.initiator?.attributes;
  const v = attrs?.["open_everywhere_webhook_id"];
  return typeof v === "string" ? v.length > 0 : Array.isArray(v) && v.length > 0;
}

function surfaceType(ctx: BindableContext): string {
  if (isWebhookFire(ctx)) return "webhook";
  try {
    return bindFrom(ctx).platform;
  } catch {
    return "local";
  }
}

function turnKindForTelemetry(ctx: BindableContext): string {
  try {
    const auth = ctx.session?.auth;
    const attrs = auth?.current?.attributes ?? auth?.initiator?.attributes;
    if (routineMarker(attrs)) return "routine";
    if (isWebhookFire(ctx)) return "webhook";
    const mode = bindFrom(ctx).mode;
    if (mode === "dm") return "dm";
    if (mode === "mpim") return "mpim";
    return "channel";
  } catch {
    return "channel";
  }
}

export default defineHook({
  events: {
    "turn.started": async (event) => {
      resetTurn(event.data.turnId, Date.now());
      maybeHeartbeat();
    },
    "step.completed": async (event) => {
      bumpTurn(event.data?.usage);
    },
    "turn.completed": async (_event, ctx: HookContext) => {
      const turn = readTurn();
      const now = Date.now();
      const startedAt = turn?.startedAt ?? now;
      emitTelemetry("oe.turn.completed", {
        "oe.surface": surfaceType(ctx),
        "oe.kind": turnKindForTelemetry(ctx),
        "gen_ai.request.model": readModelStamp() ?? "unknown",
        "oe.tokens.bucket": tokensBucket(turn?.tokens ?? 0),
        "oe.steps.bucket": stepsBucket(turn?.steps ?? 0),
        "oe.latency.bucket": latencyBucket(now - startedAt),
      });
      await flushTelemetry();
    },
    "turn.failed": async (event, ctx: HookContext) => {
      emitTelemetry("oe.turn.failed", {
        "oe.surface": surfaceType(ctx),
        "oe.error.code": event.data?.code ?? "unknown",
      });
      await flushTelemetry();
    },
  },
});
