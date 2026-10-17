import { defineState } from "eve/context";
import type { ModelBackend, RoutableModel, RoutingDeps } from "./routing.js";

const STREAM_DROP_MESSAGES: readonly string[] = [
  "stream ended before terminal chunk",
  "premature close",
  "other side closed",
  "stream closed before completion",
];

const STREAM_DROP_CODES: readonly string[] = ["ERR_STREAM_PREMATURE_CLOSE"];

const ABORT_NAMES: readonly string[] = ["AbortError", "TimeoutError"];

function causeChain(error: unknown): readonly unknown[] {
  const out: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    out.push(current);
    if (typeof current !== "object") break;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  return out;
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const held = (value as Record<string, unknown>)[field];
  return typeof held === "string" ? held : undefined;
}

export function isTransientStreamDrop(error: unknown): boolean {
  const chain = causeChain(error);
  for (const link of chain) {
    const name = stringField(link, "name");
    if (name !== undefined && ABORT_NAMES.includes(name)) return false;
  }
  for (const link of chain) {
    const code = stringField(link, "code");
    if (code !== undefined && STREAM_DROP_CODES.includes(code)) return true;
    const message = stringField(link, "message") ?? (typeof link === "string" ? link : undefined);
    if (message === undefined) continue;
    const lowered = message.toLowerCase();
    if (STREAM_DROP_MESSAGES.some((fragment) => lowered.includes(fragment))) return true;
  }
  return false;
}

const streamDropRetries = defineState<{ count: number }>("open-everywhere.worker-stream-drop-retries", () => ({ count: 0 }));

function noteStreamDropRetry(): void {
  try {
    streamDropRetries.update((s) => ({ count: s.count + 1 }));
  } catch {
  }
}

export function streamDropRetriesThisTurn(): number {
  try {
    return streamDropRetries.get().count;
  } catch {
    return 0;
  }
}

export function clearStreamDropRetries(): void {
  try {
    streamDropRetries.update(() => ({ count: 0 }));
  } catch {
  }
}

interface StreamResultLike {
  readonly stream: ReadableStream<unknown>;
  readonly [key: string]: unknown;
}

interface BufferedAttempt {
  readonly result: StreamResultLike;
  readonly parts: readonly unknown[];
  readonly drop?: unknown;
  readonly fatal?: unknown;
}

function errorPartPayload(part: unknown): unknown {
  if (part === null || typeof part !== "object") return undefined;
  const typed = part as { type?: unknown; error?: unknown };
  return typed.type === "error" ? typed.error : undefined;
}

async function bufferAttempt(model: RoutableModel, options: unknown): Promise<BufferedAttempt> {
  const result = (await model.doStream(options)) as StreamResultLike;
  const parts: unknown[] = [];
  const reader = result.stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done === true) break;
      const failure = errorPartPayload(next.value);
      if (failure !== undefined && isTransientStreamDrop(failure)) {
        await reader.cancel().catch(() => undefined);
        return { result, parts, drop: failure };
      }
      parts.push(next.value);
    }
  } catch (err) {
    if (!isTransientStreamDrop(err)) return { result, parts, fatal: err };
    return { result, parts, drop: err };
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
  return { result, parts };
}

function replay(attempt: BufferedAttempt): StreamResultLike {
  const parts = [...attempt.parts];
  const drop = attempt.drop;
  const fatal = attempt.fatal;
  return {
    ...attempt.result,
    stream: new ReadableStream<unknown>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        if (fatal !== undefined) {
          controller.error(fatal);
          return;
        }
        if (drop !== undefined) controller.enqueue({ type: "error", error: drop });
        controller.close();
      },
    }),
  };
}

function retryingModel<TModel extends RoutableModel>(model: TModel): TModel {
  const decorated: RoutableModel = {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options: unknown) {
      try {
        return await model.doGenerate(options);
      } catch (err) {
        if (!isTransientStreamDrop(err)) throw err;
        noteStreamDropRetry();
        return await model.doGenerate(options);
      }
    },
    async doStream(options: unknown) {
      let first: BufferedAttempt;
      try {
        first = await bufferAttempt(model, options);
      } catch (err) {
        if (!isTransientStreamDrop(err)) throw err;
        noteStreamDropRetry();
        return replay(await bufferAttempt(model, options));
      }
      if (first.drop === undefined) return replay(first);
      noteStreamDropRetry();
      return replay(await bufferAttempt(model, options));
    },
  };
  return decorated as TModel;
}

export function withStreamDropRetry<TModel extends RoutableModel>(deps: RoutingDeps<TModel>, armed: boolean): RoutingDeps<TModel> {
  if (!armed) return deps;
  const backend: ModelBackend<TModel> = {
    model: (id: string, via?: string) => retryingModel(via === undefined ? deps.backend.model(id) : deps.backend.model(id, via)),
    applyOptions: (route, options, ids) => deps.backend.applyOptions(route, options, ids),
  };
  return { ...deps, backend };
}
