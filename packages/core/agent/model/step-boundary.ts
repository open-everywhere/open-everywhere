import { currentTurnId, currentSessionId, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { getSettings } from "../settings/settings.js";
import { appendAudit } from "../audit/audit.js";
import type { RoutableModel, RoutedCallOptions } from "./routing.js";

export type StepBoundaryTier = "none" | "soft" | "hard";

export interface StepBoundaryDecision {
  readonly tier: StepBoundaryTier;
  readonly count: number;
  readonly budget: number;
  readonly backstop: number;
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly crossed: boolean;
}

const INERT: StepBoundaryDecision = { tier: "none", count: 0, budget: 0, backstop: 0, crossed: false };

export const MAX_TRACKED_TURNS = 512;

const counts = new Map<string, number>();

export function stepCountKey(sessionId: string | undefined, turnId: string): string {
  return sessionId !== undefined ? `${sessionId}:${turnId}` : turnId;
}

function bump(key: string): number {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  if (counts.size > MAX_TRACKED_TURNS) {
    const oldest = counts.keys().next();
    if (!oldest.done) counts.delete(oldest.value);
  }
  return next;
}

export function clearTurnStepCount(sessionId: string | undefined, turnId: string | undefined): void {
  if (turnId !== undefined) counts.delete(stepCountKey(sessionId, turnId));
}

export function _resetStepBoundaryCountsForTest(): void {
  counts.clear();
}

export function classifyStepCount(count: number, budget: number, backstop: number): StepBoundaryTier {
  if (budget <= 0) return "none";
  if (count > backstop) return "hard";
  if (count > budget) return "soft";
  return "none";
}

export function stepBoundaryLimits(settings = getSettings()): { budget: number; backstop: number } {
  const budget = Math.max(0, Math.floor(settings.turn.stepBudget));
  const multiple = Math.max(1, settings.turn.stepBackstopMultiple);
  return { budget, backstop: Math.floor(budget * multiple) };
}

export function noteTurnStep(ctx: BindableContext, settings = getSettings()): StepBoundaryDecision {
  let budget: number;
  let backstop: number;
  try {
    ({ budget, backstop } = stepBoundaryLimits(settings));
  } catch {
    return INERT;
  }
  if (budget <= 0) return INERT;
  let turnId: string | undefined;
  let sessionId: string | undefined;
  try {
    turnId = currentTurnId(ctx);
    sessionId = currentSessionId(ctx);
  } catch {
    return INERT;
  }
  if (turnId === undefined) return INERT;
  const count = bump(stepCountKey(sessionId, turnId));
  const tier = classifyStepCount(count, budget, backstop);
  const previous = classifyStepCount(count - 1, budget, backstop);
  return { tier, count, budget, backstop, turnId, sessionId, crossed: tier !== previous };
}

export const STEP_BOUNDARY_MARKER = "⏸️ TURN STEP BOUNDARY (open-everywhere harness — not from the person)";

export function wrapUpNotice(d: StepBoundaryDecision): string {
  return (
    `${STEP_BOUNDARY_MARKER}: this turn has now taken ${d.count} model round-trips, past its budget of ` +
    `${d.budget}. Nothing is broken and you have not been cut off — but the turn has run long enough that ` +
    `it must now YIELD. Finish or safely park the unit of work you are on, then END THE TURN with a report: ` +
    `what you did, what you found, what is left, and what you would do next. Do not start new work, new ` +
    `investigations or new tool chains. The person can ask you to continue, and you will pick up from your ` +
    `report. If you keep working instead of yielding, this turn will be stopped outright at ${d.backstop} ` +
    `round-trips and your work will be reported for you, less well than you would report it.`
  );
}

export function backstopReply(d: StepBoundaryDecision): string {
  return (
    `${STEP_BOUNDARY_MARKER}: this turn reached ${d.count} model round-trips, past the hard backstop of ` +
    `${d.backstop}, and has been stopped by the harness. The wrap-up instruction was issued at ` +
    `${d.budget} round-trips and the turn kept going, so this is a runaway loop rather than long work. ` +
    `Whatever was completed before this point stands; anything in flight did not finish. Ask me to ` +
    `continue and I will resume from where the work actually got to.`
  );
}

export function appendHarnessNotice(prompt: unknown, text: string): unknown {
  if (!Array.isArray(prompt)) return prompt;
  return [...prompt, { role: "user", content: [{ type: "text", text }] }];
}

export function withWrapUpNotice<TModel extends RoutableModel>(inner: TModel, text: string): TModel {
  const withNotice = (options: RoutedCallOptions): RoutedCallOptions => ({
    ...options,
    prompt: appendHarnessNotice((options as { prompt?: unknown }).prompt, text),
  });
  const shim: RoutableModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options: RoutedCallOptions) {
      return inner.doGenerate(withNotice(options));
    },
    async doStream(options: RoutedCallOptions) {
      return inner.doStream(withNotice(options));
    },
  };
  return shim as TModel;
}

function stubUsage(outputChars: number): Record<string, unknown> {
  const out = Math.max(1, Math.ceil(outputChars / 4));
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: out, text: out, reasoning: 0 },
  };
}

const STUB_FINISH = { unified: "stop", raw: "stop" };

export function turnBackstopModel<TModel extends RoutableModel>(inner: TModel, text: string): TModel {
  const shim: RoutableModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate() {
      return { content: [{ type: "text", text }], finishReason: STUB_FINISH, usage: stubUsage(text.length), warnings: [] };
    },
    async doStream() {
      const parts: unknown[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: `oe-step-backstop-${Date.now()}`, modelId: inner.modelId, timestamp: new Date() },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: text },
        { type: "text-end", id: "0" },
        { type: "finish", finishReason: STUB_FINISH, usage: stubUsage(text.length) },
      ];
      return {
        stream: new ReadableStream<unknown>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return shim as TModel;
}

export const STEP_BOUNDARY_ACTION = "turn.step_boundary";

export function reportStepBoundary(ctx: BindableContext, d: StepBoundaryDecision): void {
  if (!d.crossed || d.tier === "none") return;
  try {
    console.warn(
      `[open-everywhere:step-boundary] ${d.tier} boundary crossed on turn ${d.turnId}: ${d.count} model ` +
        `round-trips (budget ${d.budget}, backstop ${d.backstop}) — ` +
        (d.tier === "soft" ? "the wrap-up instruction now rides every call this turn" : "the turn was stopped by the text-only backstop"),
    );
  } catch {
  }
  let where: { org: string; platform: string; workspace: string; surface?: string };
  try {
    const p = resolvePartition(ctx);
    where = { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface };
  } catch {
    return;
  }
  void appendAudit({
    ...where,
    action: STEP_BOUNDARY_ACTION,
    detail: { tier: d.tier, steps: d.count, budget: d.budget, backstop: d.backstop, turnId: d.turnId, ...(d.sessionId ? { sessionId: d.sessionId } : {}) },
  }).catch(() => {
  });
}
