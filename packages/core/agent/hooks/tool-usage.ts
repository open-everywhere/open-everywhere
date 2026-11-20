import { defineHook, type HookContext } from "eve/hooks";
import { call, runs } from "eve/events";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { readHostStepModel, readModelStamp } from "../model/model-stamp.js";
import { turnSurfaceMode } from "./spend.js";
import { bufferToolCall, flushToolStep, flushToolTurn, toolStepKey, toolUsageNames, toolUsageOutcome } from "../spend/tool-usage.js";
import { optional } from "./control-refusal.js";

export function callOutcomeStatus(outcome: string): "rejected" | "failed" | "completed" {
  if (outcome === "rejected") return "rejected";
  return outcome === "completed" ? "completed" : "failed";
}

function sessionIdOf(ctx: HookContext): string | undefined {
  const id = ctx.session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function turnRuns(ctx: HookContext, turnId: string): ReturnType<typeof runs> {
  return runs(ctx.view, { turnId });
}

async function flushRunsWithUsage(ctx: HookContext, sessionId: string, turnId: string, except?: string): Promise<void> {
  const model = readModelStamp() ?? readHostStepModel() ?? undefined;
  const ordered = turnRuns(ctx, turnId);
  for (let index = 0; index < ordered.length; index++) {
    const run = ordered[index]!;
    if (run.runId === except || run.usage === undefined) continue;
    await flushToolStep(toolStepKey(sessionId, turnId, index), run.usage, model);
  }
}

function noteResult(event: { readonly data: { readonly callId: string; readonly outcome: string } }, ctx: HookContext): void {
  if (event.data.outcome === "interrupted" || event.data.outcome === "abandoned") return;
  const observed = call(ctx.view, event.data.callId);
  if (observed === undefined || (observed.kind !== "tool" && observed.kind !== "control") || observed.name.length === 0) return;
  const sessionId = sessionIdOf(ctx);
  if (sessionId === undefined || observed.turnId === undefined || observed.runId === undefined) return;
  const index = turnRuns(ctx, observed.turnId).findIndex((r) => r.runId === observed.runId);
  if (index < 0) return;
  const bind = ctx as unknown as BindableContext;
  const p = resolvePartition(bind);
  const mode = turnSurfaceMode(bind);
  let principalId: string | undefined;
  try {
    principalId = bindFrom(bind).principalId;
  } catch {
    principalId = undefined;
  }
  bufferToolCall(toolStepKey(sessionId, observed.turnId, index), {
    org: p.org,
    ts: new Date().toISOString(),
    surfaceKey: domainKeyOf(p),
    ...(mode !== undefined ? { surfaceMode: mode } : {}),
    ...(principalId !== undefined ? { principalId } : {}),
    sessionId,
    ...toolUsageNames(observed.name),
    outcome: toolUsageOutcome(callOutcomeStatus(event.data.outcome), false),
    callId: event.data.callId,
  });
}

export default defineHook({
  events: {
    "model.requested": optional("tool-usage", async (event, ctx) => {
      const owner = event.data.owner as { readonly turnId?: unknown };
      const sessionId = sessionIdOf(ctx);
      if (sessionId === undefined || typeof owner.turnId !== "string") return;
      await flushRunsWithUsage(ctx, sessionId, owner.turnId, event.data.runId);
    }),
    "call.settled": optional("tool-usage", (event, ctx) => noteResult(event, ctx)),
    "turn.settled": optional("tool-usage", async (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId === undefined) return;
      await flushRunsWithUsage(ctx, sessionId, event.data.turnId);
      await flushToolTurn(sessionId, event.data.turnId);
    }),
  },
});
