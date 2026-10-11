import { defineHook, type HookContext } from "eve/hooks";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { readHostStepModel, readModelStamp } from "../model/model-stamp.js";
import { turnSurfaceMode } from "./spend.js";
import { bufferToolCall, flushToolStep, flushToolTurn, toolStepKey, toolUsageNames, toolUsageOutcome, type StepUsage } from "../spend/tool-usage.js";

interface ActionResultData {
  readonly result?: { readonly kind?: string; readonly toolName?: string; readonly isError?: boolean; readonly callId?: string };
  readonly status?: unknown;
  readonly stepIndex?: number;
  readonly turnId?: string;
}

function noteResult(event: unknown, ctx: HookContext): void {
  try {
    const data = (event as { data?: ActionResultData } | undefined)?.data;
    const result = data?.result;
    if (result?.kind !== "tool-result" || typeof result.toolName !== "string" || result.toolName.length === 0) return;
    const sessionId = ctx.session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0 || typeof data?.turnId !== "string" || typeof data.stepIndex !== "number") return;
    const bind = ctx as unknown as BindableContext;
    const p = resolvePartition(bind);
    const mode = turnSurfaceMode(bind);
    let principalId: string | undefined;
    try {
      principalId = bindFrom(bind).principalId;
    } catch {
      principalId = undefined;
    }
    bufferToolCall(toolStepKey(sessionId, data.turnId, data.stepIndex), {
      org: p.org,
      ts: new Date().toISOString(),
      surfaceKey: domainKeyOf(p),
      ...(mode !== undefined ? { surfaceMode: mode } : {}),
      ...(principalId !== undefined ? { principalId } : {}),
      sessionId,
      ...toolUsageNames(result.toolName),
      outcome: toolUsageOutcome(data.status, result.isError),
      ...(typeof result.callId === "string" ? { callId: result.callId } : {}),
    });
  } catch {
  }
}

async function completeStep(event: unknown, ctx: HookContext): Promise<void> {
  try {
    const data = (event as { data?: { turnId?: string; stepIndex?: number; usage?: StepUsage } } | undefined)?.data;
    const sessionId = ctx.session?.id;
    if (typeof sessionId !== "string" || typeof data?.turnId !== "string" || typeof data.stepIndex !== "number") return;
    const model = readModelStamp() ?? readHostStepModel() ?? undefined;
    await flushToolStep(toolStepKey(sessionId, data.turnId, data.stepIndex), data.usage, model);
  } catch {
  }
}

async function endTurn(event: unknown, ctx: HookContext): Promise<void> {
  try {
    const turnId = (event as { data?: { turnId?: string } } | undefined)?.data?.turnId;
    const sessionId = ctx.session?.id;
    if (typeof sessionId === "string" && typeof turnId === "string") await flushToolTurn(sessionId, turnId);
  } catch {
  }
}

export default defineHook({
  events: {
    "action.result": async (event, ctx) => noteResult(event, ctx),
    "step.completed": (event, ctx) => completeStep(event, ctx),
    "turn.completed": (event, ctx) => endTurn(event, ctx),
    "turn.failed": (event, ctx) => endTurn(event, ctx),
    "turn.cancelled": (event, ctx) => endTurn(event, ctx),
  },
});
