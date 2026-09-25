process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { HookContext } from "eve/hooks";
import {
  clearStreamDropRetries,
  isTransientStreamDrop,
  streamDropRetriesThisTurn,
  withStreamDropRetry,
} from "../agent/model/stream-drop-retry.js";
import type { ModelBackend, RoutableModel, RoutingDeps } from "../agent/model/routing.js";
import { readAudit, type AuditEntry } from "../agent/audit/audit.js";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}`);
}

const S24_DROP = "Upstream stream ended before terminal chunk";

console.log("§1 what counts as a transient stream drop");
{
  ok(isTransientStreamDrop(new Error(S24_DROP)), "🔴 the S24 message is admitted — this is the class the ticket is about");
  ok(isTransientStreamDrop(new Error(`Gateway: ${S24_DROP}.`)), "…as a substring, so the gateway may wrap it in its own prose");
  ok(isTransientStreamDrop(new Error("MODEL_CALL_FAILED")) === false, "🔴 a bare MODEL_CALL_FAILED is NOT admitted — the class is the transport's words, never 'the call failed'");

  const wrapped = new Error("model call failed");
  (wrapped as { cause?: unknown }).cause = new Error(S24_DROP);
  ok(isTransientStreamDrop(wrapped), "a drop reached through the CAUSE chain is admitted — eve normalizes stream errors by wrapping them");

  const coded = new Error("aborted");
  (coded as { code?: string }).code = "ERR_STREAM_PREMATURE_CLOSE";
  ok(isTransientStreamDrop(coded), "Node's own premature-close code is admitted");

  ok(isTransientStreamDrop(new Error("The model provider filtered this response.")) === false, "🔴 a CONTENT FILTER is not retried — the provider has judged the request and a re-send can only fail again");
  ok(isTransientStreamDrop(new Error("Tool execution denied")) === false, "🔴 a tool error is not retried");
  ok(isTransientStreamDrop(new Error("AI Gateway rejected the model request")) === false, "🔴 a gateway REJECTION is not retried");
  const abort = new Error(S24_DROP);
  abort.name = "AbortError";
  ok(isTransientStreamDrop(abort) === false, "🔴 AN ABORT CARRYING THE DROP'S OWN MESSAGE IS NOT RETRIED — a cancelled turn must never be re-sent, so the abort exclusion is checked FIRST and over the whole chain");

  ok(isTransientStreamDrop(undefined) === false && isTransientStreamDrop(null) === false && isTransientStreamDrop({}) === false, "a non-error value is simply not admitted");
  const cyclic: { cause?: unknown; message: string } = { message: "x" };
  cyclic.cause = cyclic;
  ok(isTransientStreamDrop(cyclic) === false, "a self-referential cause chain terminates instead of hanging the decorator");
}

console.log("§1b this module admits nothing eve's own classifier already retries");
{
  const require0 = createRequire(import.meta.url);
  const eveDir = dirname(require0.resolve("eve/package.json"));
  const { readFileSync } = await import("node:fs");
  const system = readFileSync(join(eveDir, "dist/src/harness/semantic-errors/rules/system.js"), "utf8");
  const codes = /NETWORK_ERROR_CODES=\[([^\]]*)\]/.exec(system)?.[1] ?? "";
  ok(codes.length > 0, "eve still declares a NETWORK_ERROR_CODES list — this tripwire reads it, so a rename must red here");
  const eveCodes = codes.split(",").map((c) => c.replaceAll("`", "").trim());
  ok(eveCodes.includes("ECONNRESET") && eveCodes.includes("UND_ERR_SOCKET") && eveCodes.includes("EPIPE"), "…and it still holds the socket codes, which is WHY this module must not");
  for (const code of eveCodes) {
    const err = new Error("x");
    (err as { code?: string }).code = code;
    ok(isTransientStreamDrop(err) === false, `🔴 \`${code}\` is eve's to retry, not this module's — admitting it would multiply the two retry loops`);
  }
  for (const exact of ["fetch failed", "socket hang up", "terminated"]) {
    ok(system.includes(`\`${exact}\``), `eve still matches "${exact}" exactly as transient`);
    ok(isTransientStreamDrop(new Error(exact)) === false, `🔴 …so "${exact}" is not admitted here either`);
  }
  ok(isTransientStreamDrop(Object.assign(new Error("x"), { code: "ERR_STREAM_PREMATURE_CLOSE" })), "…while `ERR_STREAM_PREMATURE_CLOSE`, which eve's list does NOT hold, is this module's to retry");
}

type Attempt = { readonly parts: readonly unknown[]; readonly throws?: unknown; readonly errorPart?: unknown };

interface Recorder {
  calls: number;
  cancelled?: number;
}

function textPart(text: string): unknown {
  return { type: "text-delta", delta: text };
}

function scriptedModel(script: readonly Attempt[], recorder: Recorder): RoutableModel {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    async doGenerate() {
      const attempt = script[recorder.calls++] ?? script[script.length - 1]!;
      if (attempt.throws !== undefined) throw attempt.throws;
      return { content: attempt.parts };
    },
    async doStream() {
      const attempt = script[recorder.calls++] ?? script[script.length - 1]!;
      return {
        stream: new ReadableStream<unknown>({
          start(controller) {
            for (const part of attempt.parts) controller.enqueue(part);
            if (attempt.errorPart !== undefined) {
              controller.enqueue({ type: "error", error: attempt.errorPart });
              return;
            }
            if (attempt.throws !== undefined) {
              controller.error(attempt.throws);
              return;
            }
            controller.close();
          },
          cancel() {
            recorder.cancelled = (recorder.cancelled ?? 0) + 1;
          },
        }),
        request: { body: "scripted" },
      };
    },
  };
}

function depsFor(model: RoutableModel): RoutingDeps {
  const backend: ModelBackend = {
    model: () => model,
    applyOptions: (_route, options) => options,
  };
  return { domains: () => [], backend } as unknown as RoutingDeps;
}

async function drain(model: RoutableModel): Promise<{ parts: unknown[]; error?: unknown; callRejected?: unknown }> {
  const parts: unknown[] = [];
  let result: { stream: ReadableStream<unknown> };
  try {
    result = (await model.doStream({})) as { stream: ReadableStream<unknown> };
  } catch (err) {
    return { parts, callRejected: err };
  }
  const reader = result.stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done === true) break;
      parts.push(next.value);
    }
  } catch (err) {
    return { parts, error: err };
  }
  return { parts };
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

async function inSession(fn: () => Promise<void>): Promise<void> {
  await contextStorage.run(new ContextContainer(), fn);
}

function errorPayloads(parts: readonly unknown[]): unknown[] {
  return parts.flatMap((p) => (p !== null && typeof p === "object" && (p as { type?: unknown }).type === "error" ? [(p as { error?: unknown }).error] : []));
}

function text(parts: readonly unknown[]): string {
  return parts.map((p) => (p !== null && typeof p === "object" ? String((p as { delta?: unknown }).delta ?? "") : "")).join("");
}

console.log("§2 a thrown drop on attempt 1 is retried once");
{
  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const script: Attempt[] = [
      { parts: [], throws: new Error(S24_DROP) },
      { parts: [textPart("the page is at ..."), { type: "finish" }] },
    ];
    const deps = withStreamDropRetry(depsFor(scriptedModel(script, recorder)), true);
    const drained = await drain(deps.backend.model("test-model"));
    ok(recorder.calls === 2, "🔴 THE POINT OF THE TICKET: the step was re-sent exactly once");
    ok(drained.error === undefined, "…and the consumer sees no failure");
    ok(text(drained.parts) === "the page is at ...", "…it sees attempt 2's answer, once");
    ok(streamDropRetriesThisTurn() === 1, "…and the turn records one retry, which is what the failure row reads");
  });
}

console.log("§3 an in-band drop is retried, and attempt 1's partial text is discarded");
{
  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const script: Attempt[] = [
      { parts: [textPart("I found the pa")], errorPart: new Error(S24_DROP) },
      { parts: [textPart("I found the page: Q3 notes."), { type: "finish" }] },
    ];
    const deps = withStreamDropRetry(depsFor(scriptedModel(script, recorder)), true);
    const drained = await drain(deps.backend.model("test-model"));
    ok(recorder.calls === 2, "an `error` PART carrying the drop triggers the same retry a throw does");
    ok(errorPayloads(drained.parts).length === 0, "…and no error part reaches the consumer");
    ok(
      text(drained.parts) === "I found the page: Q3 notes.",
      "🔴 THE SAFETY PROPERTY: attempt 1's partial text is DISCARDED. Forwarding it would hand eve a truncated sentence followed by a complete one — a duplicated, self-contradicting answer, which is worse than the failure it replaces",
    );
    ok(
      recorder.cancelled === 1,
      "🔴 AND THE ABANDONED ATTEMPT'S STREAM IS CANCELLED, not merely released — an in-band `error` part is not a dead socket, so releasing the lock alone would hold that response body until the provider timed it out, once per retried step",
    );
  });

  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const deps = withStreamDropRetry(depsFor(scriptedModel([{ parts: [textPart("clean"), { type: "finish" }] }], recorder)), true);
    await drain(deps.backend.model("test-model"));
    ok(recorder.cancelled === undefined, "a clean attempt is not cancelled — it ended on its own");
  });
}

console.log("§4 a second drop still fails the turn");
{
  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const drop = new Error(S24_DROP);
    const script: Attempt[] = [{ parts: [], errorPart: drop }, { parts: [textPart("half")], errorPart: drop }];
    const deps = withStreamDropRetry(depsFor(scriptedModel(script, recorder)), true);
    const drained = await drain(deps.backend.model("test-model"));
    ok(recorder.calls === 2, "🔴 exactly TWO attempts — there is no third, so a persistently broken gateway is not hammered");
    ok(errorPayloads(drained.parts)[0] === drop, "…and the SECOND drop reaches eve as the provider's own error part, so eve classifies the failure from the payload rather than from a shape this module invented");
    ok(streamDropRetriesThisTurn() === 1, "…and the count the failure row reads is 1");
  });

  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const deps = withStreamDropRetry(depsFor(scriptedModel([{ parts: [], throws: new Error(S24_DROP) }], recorder)), true);
    const drained = await drain(deps.backend.model("test-model"));
    ok(recorder.calls === 2, "a THROWN second drop is also the last attempt");
    ok(drained.error !== undefined || errorPayloads(drained.parts).length === 1, "…and the failure still reaches the consumer");
  });
}

console.log("§5 the negative controls");
{
  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const refusal = new Error("The model provider filtered this response.");
    const deps = withStreamDropRetry(depsFor(scriptedModel([{ parts: [], throws: refusal }], recorder)), true);
    const drained = await drain(deps.backend.model("test-model"));
    ok(recorder.calls === 1, "🔴 a NON-transient failure is not retried at all — one attempt, exactly as before this ticket");
    ok(drained.error === refusal, "…and it reaches eve unchanged, so its classification is untouched");
    ok(
      drained.callRejected === undefined,
      "🔴 AND IT STILL ARRIVES AS A READER REJECTION, not as a rejection of `doStream` — that is where eve's own normalisation and classification read a mid-stream failure, and moving it would change eve's path on every non-transient failure a worker meets",
    );
    ok(streamDropRetriesThisTurn() === 0, "…and no retry is recorded, so §2's count was not a free pass");
  });

  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const model = scriptedModel([{ parts: [], throws: new Error(S24_DROP) }, { parts: [textPart("ok")] }], recorder);
    const deps = withStreamDropRetry(depsFor(model), false);
    ok(deps.backend.model("test-model") === model, "🔴 DISARMED, the decorator returns the model untouched — a SEAT's step is not wrapped, and neither is its stream buffered");
    const drained = await drain(deps.backend.model("test-model"));
    ok(recorder.calls === 1 && drained.error !== undefined, "…so a seat's drop fails exactly as it does today");
  });

  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const deps = withStreamDropRetry(depsFor(scriptedModel([{ parts: [], throws: new Error(S24_DROP) }, { parts: ["generated"] }], recorder)), true);
    const generated = (await deps.backend.model("test-model").doGenerate({})) as { content?: unknown };
    ok(recorder.calls === 2, "the non-streaming path retries the same one class");
    ok(Array.isArray(generated.content), "…and returns attempt 2's result");
  });
}

console.log("§5b the arm is the worker bit, driven through the real resolver");
{
  const { resolvePrimaryModel } = await import("../agent/model/routing.js");
  const { setWorkerWake } = await import("../agent/access/worker-seat-state.js");

  const childCtx = {
    channel: { kind: "slack", continuationToken: "subagent:wrun_PARENT:call_ABC" },
    session: {
      id: "wrun_CHILD",
      auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", is_private: "false", trust_checked: "true" }, principalId: "U1", principalType: "user" } },
    },
  };

  async function armedFor(worker: boolean): Promise<boolean> {
    const recorder: Recorder = { calls: 0 };
    const inner = scriptedModel([{ parts: [], throws: new Error(S24_DROP) }, { parts: [textPart("ok")] }], recorder);
    let handed: unknown;
    await inSession(async () => {
      setWorkerWake(worker);
      handed = await resolvePrimaryModel(childCtx as never, { primary: { id: "test-model" } }, depsFor(inner) as never);
    });
    return handed !== inner;
  }

  ok(await armedFor(true), "🔴 a grain-`task` DELEGATED WORKER is armed — the resolver hands back a decorated model");
  ok(
    (await armedFor(false)) === false,
    "🔴 AND A SUBAGENT CHILD THAT IS NOT A WORKER IS NOT — the arm is `currentWorkerWake()`, strictly narrower than `isSubagentChildContext`, so whole-stream buffering reaches only the sessions this ticket scoped",
  );
}

console.log("§6 the per-turn clear, and the field on the failure row");

const ACTION = "delegation.worker_turn_failed";

async function settledRows(): Promise<AuditEntry[]> {
  let stable = 0;
  let last = -1;
  for (let attempt = 0; attempt < 150 && stable < 8; attempt += 1) {
    const rows = await readAudit({ org: "default", action: ACTION });
    if (rows.length === last) stable += 1;
    else {
      stable = 0;
      last = rows.length;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return readAudit({ org: "default", action: ACTION });
}

const spawnTaint = (await import("../agent/hooks/spawn-taint.js")).default;
const events = (spawnTaint as { events?: Record<string, unknown> }).events ?? {};
const turnStarted = events["turn.started"] as ((event: unknown, ctx: HookContext) => void) | undefined;
const turnFailed = events["turn.failed"] as ((event: unknown, ctx: HookContext) => Promise<void>) | undefined;
assert.ok(turnStarted !== undefined && turnFailed !== undefined, "both spawn-taint arms must exist for §6 to mean anything");

function workerCtx(sessionId: string): HookContext {
  return { session: { id: sessionId }, channel: { continuationToken: "subagent:wrun_PARENT:call_ABC" } } as unknown as HookContext;
}

function turnFailedEvent() {
  return {
    type: "turn.failed",
    data: { code: "MODEL_CALL_FAILED", message: S24_DROP, details: { errorId: "err_2132", name: "Error", detail: `Error: ${S24_DROP}\n    at doStream (x.js:1:1)\n` } },
  };
}

{
  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const drop = new Error(S24_DROP);
    const deps = withStreamDropRetry(depsFor(scriptedModel([{ parts: [], errorPart: drop }, { parts: [], errorPart: drop }], recorder)), true);
    await drain(deps.backend.model("test-model"));
    await turnFailed(turnFailedEvent(), workerCtx("wrun_RETRIED"));
  });
  let rows = await settledRows();
  const retried = rows.find((r) => (r.detail as Record<string, unknown>).session === "wrun_RETRIED");
  ok(retried !== undefined, "the worker's failure row landed");
  ok((retried?.detail as Record<string, unknown>).retried === 1, "🔴 the row says `retried: 1` — without it, 'the retry did not help' and 'the retry never ran' are the same row");

  await inSession(async () => {
    await turnFailed(turnFailedEvent(), workerCtx("wrun_FIRST_TRY"));
  });
  rows = await settledRows();
  const plain = rows.find((r) => (r.detail as Record<string, unknown>).session === "wrun_FIRST_TRY");
  ok(plain !== undefined, "the second row landed");
  ok((plain?.detail as Record<string, unknown>).retried === undefined, "🔴 a death nothing re-ran carries NO `retried` field, so the field means what it says");

  await inSession(async () => {
    const recorder: Recorder = { calls: 0 };
    const deps = withStreamDropRetry(depsFor(scriptedModel([{ parts: [], throws: new Error(S24_DROP) }, { parts: [] }], recorder)), true);
    await drain(deps.backend.model("test-model"));
    ok(streamDropRetriesThisTurn() === 1, "turn 1 spent a retry");
    turnStarted({ type: "turn.started", data: {} }, workerCtx("wrun_TWO_TURNS"));
    ok(streamDropRetriesThisTurn() === 0, "🔴 the worker's own `turn.started` CLEARS the count — a session's second failing turn must not report the first turn's re-send");
  });

  clearStreamDropRetries();
  ok(streamDropRetriesThisTurn() === 0, "outside an eve context both the clear and the read are silent no-ops");
}

console.log(failures === 0 ? "\nall green" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
