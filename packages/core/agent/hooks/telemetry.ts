import { defineHook, type HookContext } from "eve/hooks";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";
import { readModelStamp } from "../model/model-stamp.js";
import { emitTelemetry, flushTelemetry, maybeHeartbeat, tokensBucket, stepsBucket, latencyBucket } from "../observability/telemetry.js";
import { bumpTurnClock, readTurnClock, resetTurnClock } from "../observability/turn-clock.js";
import { optional } from "./control-refusal.js";

function bumpTurn(usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
  bumpTurnClock((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
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

function emitTurnCompleted(ctx: HookContext): void {
  const turn = readTurnClock();
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
}

export default defineHook({
  events: {
    "turn.started": optional("telemetry", async (event, ctx) => {
      resetTurnClock(event.data.turnId, Date.now(), ctx.session?.id ?? "");
      maybeHeartbeat();
    }),
    "usage.recorded": optional("telemetry", async (event, ctx) => {
      const owner = event.data.owner as { readonly runId?: unknown } | undefined;
      if (event.data.kind !== "model" || typeof owner?.runId !== "string") return;
      bumpTurn(event.data.usage);
      const turn = readTurnClock();
      if (turn?.steps !== 1) return;
      emitTelemetry("oe.turn.first_output", {
        "oe.surface": surfaceType(ctx),
        "oe.kind": turnKindForTelemetry(ctx),
        "oe.latency.bucket": latencyBucket(Date.now() - turn.startedAt),
      });
    }),
    "turn.settled": optional("telemetry", async (event, ctx) => {
      switch (event.data.outcome) {
        case "completed":
          emitTurnCompleted(ctx);
          break;
        case "failed":
          emitTelemetry("oe.turn.failed", {
            "oe.surface": surfaceType(ctx),
            "oe.error.code": event.data.error?.code ?? "unknown",
          });
          break;
        default:
          return;
      }
      await flushTelemetry();
    }),
  },
});
