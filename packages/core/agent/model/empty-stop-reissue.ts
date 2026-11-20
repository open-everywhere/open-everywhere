import type { ModelBackend, RoutableModel, RoutingDeps } from "./routing.js";

export const EMPTY_STOP_FINISH_REASON = "other";

interface FinishReasonV3 {
  readonly unified: string;
  readonly raw?: string;
}

type FinishReason = string | FinishReasonV3;

function isStop(reason: unknown): boolean {
  if (reason === "stop") return true;
  return typeof reason === "object" && reason !== null && (reason as FinishReasonV3).unified === "stop";
}

function asNonStop(reason: FinishReason): FinishReason {
  if (typeof reason === "string") return EMPTY_STOP_FINISH_REASON;
  return { ...reason, unified: EMPTY_STOP_FINISH_REASON };
}

export function contentAnswers(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p === null || typeof p !== "object") return false;
    if (p.type === "tool-call" || p.type === "tool-result") return true;
    return p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0;
  });
}

class StreamFacts {
  private text = "";
  private answered = false;

  note(part: unknown): void {
    const p = part as { type?: unknown; delta?: unknown; textDelta?: unknown } | null;
    if (p === null || typeof p !== "object") return;
    if (p.type === "tool-call" || p.type === "tool-result" || p.type === "tool-input-start") {
      this.answered = true;
      return;
    }
    if (p.type === "text-delta") {
      const delta = typeof p.delta === "string" ? p.delta : typeof p.textDelta === "string" ? p.textDelta : "";
      if (!this.answered && delta.length > 0) {
        this.text += delta;
        if (this.text.trim().length > 0) this.answered = true;
      }
    }
  }

  get empty(): boolean {
    return !this.answered;
  }
}

function rewriteFinish(part: unknown, facts: StreamFacts): unknown {
  const p = part as { type?: unknown; finishReason?: unknown } | null;
  if (p === null || typeof p !== "object" || p.type !== "finish") return part;
  if (!facts.empty || !isStop(p.finishReason)) return part;
  return { ...p, finishReason: asNonStop(p.finishReason as FinishReason) };
}

let warnedUnreadableStream = false;

function warnUnreadableStreamOnce(modelId: string): void {
  if (warnedUnreadableStream) return;
  warnedUnreadableStream = true;
  try {
    console.warn(
      `[open-everywhere:empty-stop-reissue] model ${modelId} returned no ReadableStream from doStream — ` +
        "an empty `stop` step on this model is not reissued",
    );
  } catch {
  }
}

const WRAPPED = new WeakMap<object, RoutableModel>();

export function unwrapEmptyStopReissue<TModel>(model: TModel): TModel {
  const inner = typeof model === "object" && model !== null ? WRAPPED.get(model) : undefined;
  return (inner ?? model) as TModel;
}

export function withEmptyStopReissue<TModel extends RoutableModel>(inner: TModel): TModel {
  const shim: RoutableModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options: unknown) {
      const result = (await inner.doGenerate(options)) as { content?: unknown; finishReason?: unknown } | null;
      if (result === null || typeof result !== "object") return result;
      if (contentAnswers(result.content) || !isStop(result.finishReason)) return result;
      return { ...result, finishReason: asNonStop(result.finishReason as FinishReason) };
    },
    async doStream(options: unknown) {
      const result = (await inner.doStream(options)) as { stream?: unknown } | null;
      if (result === null || typeof result !== "object" || !(result.stream instanceof ReadableStream)) {
        warnUnreadableStreamOnce(inner.modelId);
        return result;
      }
      const facts = new StreamFacts();
      const stream = (result.stream as ReadableStream<unknown>).pipeThrough(
        new TransformStream<unknown, unknown>({
          transform(part, controller) {
            facts.note(part);
            controller.enqueue(rewriteFinish(part, facts));
          },
        }),
      );
      return { ...result, stream };
    },
  };
  WRAPPED.set(shim, inner);
  return shim as TModel;
}

export function withEmptyStopReissueDeps<TModel extends RoutableModel>(deps: RoutingDeps<TModel>): RoutingDeps<TModel> {
  const backend: ModelBackend<TModel> = {
    model: (id: string, via?: string) => withEmptyStopReissue(via === undefined ? deps.backend.model(id) : deps.backend.model(id, via)),
    applyOptions: (route, options, ids) => deps.backend.applyOptions(route, options, ids),
  };
  return { ...deps, backend };
}
