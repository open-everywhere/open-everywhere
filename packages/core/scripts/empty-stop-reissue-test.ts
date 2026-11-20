import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-empty-stop-reissue-"));
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { EMPTY_STOP_FINISH_REASON, contentAnswers, withEmptyStopReissue } = await import("../agent/model/empty-stop-reissue.js");
const { resolvePrimaryModel } = await import("../agent/model/routing.js");

type RoutableModel = import("../agent/model/routing.js").RoutableModel;
type RoutingDeps = import("../agent/model/routing.js").RoutingDeps;
type BindableContext = import("../agent/identity/binding.js").BindableContext;

let failures = 0;
let n = 0;
function ok(cond: boolean, label: string): void {
  n += 1;
  if (cond) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}`);
}

const STOP = { unified: "stop", raw: "stop" };

function streamModel(parts: readonly unknown[], id = "fake/model"): RoutableModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason: STOP, usage: {}, warnings: [] };
    },
    async doStream() {
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
}

function generateModel(content: readonly unknown[], finishReason: unknown): RoutableModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake/model",
    supportedUrls: {},
    async doGenerate() {
      return { content, finishReason, usage: {}, warnings: [] };
    },
    async doStream() {
      throw new Error("not used");
    },
  };
}

async function finishOf(model: RoutableModel): Promise<unknown> {
  const { stream } = (await model.doStream({})) as { stream: ReadableStream<unknown> };
  const reader = stream.getReader();
  let finish: unknown;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((value as { type?: unknown }).type === "finish") finish = (value as { finishReason?: unknown }).finishReason;
  }
  return finish;
}

function unifiedOf(reason: unknown): unknown {
  return typeof reason === "object" && reason !== null ? (reason as { unified?: unknown }).unified : reason;
}

const head = [{ type: "stream-start", warnings: [] }];
const finish = (reason: unknown = STOP) => ({ type: "finish", finishReason: reason, usage: {} });
const text = (delta: string) => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta },
  { type: "text-end", id: "0" },
];

console.log("§1 a streamed step with no answer and finish reason `stop` loses the `stop`");
{
  const empty = await finishOf(withEmptyStopReissue(streamModel([...head, finish()])));
  ok(unifiedOf(empty) === EMPTY_STOP_FINISH_REASON, "🔴 an empty `stop` step reads as a non-stop finish, so eve's empty-response recovery reissues it");
  ok((empty as { raw?: unknown }).raw === "stop", "the provider's raw reason is kept for the record");
  const blank = await finishOf(withEmptyStopReissue(streamModel([...head, ...text("  \n "), finish()])));
  ok(unifiedOf(blank) === EMPTY_STOP_FINISH_REASON, "🔴 whitespace-only text is empty, as eve's own empty test reads it");
  const reasoning = await finishOf(withEmptyStopReissue(streamModel([...head, { type: "reasoning-delta", id: "r", delta: "thinking" }, finish()])));
  ok(unifiedOf(reasoning) === EMPTY_STOP_FINISH_REASON, "reasoning alone is no answer");
  const legacy = await finishOf(withEmptyStopReissue(streamModel([...head, finish("stop")])));
  ok(legacy === EMPTY_STOP_FINISH_REASON, "a string finish reason is rewritten too");
}

console.log("§2 a step that answers keeps its finish reason (negative controls)");
{
  const said = await finishOf(withEmptyStopReissue(streamModel([...head, ...text("the answer"), finish()])));
  ok(unifiedOf(said) === "stop", "🔴 a text answer keeps `stop`");
  const called = await finishOf(
    withEmptyStopReissue(streamModel([...head, { type: "tool-call", toolCallId: "c1", toolName: "no_reply", input: "{}" }, finish({ unified: "tool-calls", raw: "tool_use" })])),
  );
  ok(unifiedOf(called) === "tool-calls", "a tool call keeps its finish reason");
  const calledStop = await finishOf(withEmptyStopReissue(streamModel([...head, { type: "tool-call", toolCallId: "c1", toolName: "no_reply", input: "{}" }, finish()])));
  ok(unifiedOf(calledStop) === "stop", "🔴 a tool call that ends on `stop` keeps `stop`");
  const providerResult = await finishOf(withEmptyStopReissue(streamModel([...head, { type: "tool-result", toolCallId: "p1", toolName: "web_search", result: {} }, finish()])));
  ok(unifiedOf(providerResult) === "stop", "a provider-executed tool result is an answer");
  const cut = await finishOf(withEmptyStopReissue(streamModel([...head, finish({ unified: "length", raw: "max_tokens" })])));
  ok(unifiedOf(cut) === "length", "an empty step that did not end on `stop` is not touched — eve already reads it as empty");
}

console.log("§3 doGenerate takes the same rule");
{
  const empty = (await withEmptyStopReissue(generateModel([], STOP)).doGenerate({})) as { finishReason: unknown };
  ok(unifiedOf(empty.finishReason) === EMPTY_STOP_FINISH_REASON, "🔴 an empty generated `stop` loses the `stop`");
  const said = (await withEmptyStopReissue(generateModel([{ type: "text", text: "hi" }], STOP)).doGenerate({})) as { finishReason: unknown };
  ok(unifiedOf(said.finishReason) === "stop", "a generated answer keeps `stop`");
  ok(!contentAnswers([{ type: "text", text: " " }]) && contentAnswers([{ type: "tool-call" }]), "contentAnswers reads text by its trimmed length and any tool call as an answer");
}

console.log("§4 the primary model resolver applies the rule (reachability)");
{
  const deps: RoutingDeps = {
    domains: () => [],
    backend: { model: (id: string) => streamModel([...head, finish()], id), applyOptions: (_route, options) => options },
  };
  const ctx = {
    channel: { kind: "slack" },
    session: {
      id: "empty-stop-session",
      auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", is_private: "false", trust_checked: "true" }, principalId: "U1", principalType: "user" } },
    },
  } as unknown as BindableContext;
  const model = await resolvePrimaryModel(ctx, { primary: { id: "vendor/default-model" } }, deps, { data: { turnId: "turn_1" } });
  ok(unifiedOf(await finishOf(model)) === EMPTY_STOP_FINISH_REASON, "🔴 resolvePrimaryModel's model reissues an empty `stop` step");
}

removeTempDir(tmp);
if (failures > 0) {
  console.error(`\nempty-stop-reissue: ${failures} of ${n} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nempty-stop-reissue: all ${n} checks passed`);
