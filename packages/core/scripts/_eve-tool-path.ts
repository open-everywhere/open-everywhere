import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { seatCut } from "../agent/access/seat-cut.js";
import { installedEveRoot, readEveSchemaHelpers, SCHEMA_PATH } from "./eve-tool-schema.js";

// The eve 1.x path for ONE authored tool call, for the transform tests (outbound filter,
// nullable-optional rewrite, test-run fence). Each step is the step eve runs, not a model of it:
//
// 1. The roster shim: `seatCut(name, tool)`, a `defineDynamic` sentinel, evaluated as eve evaluates
//    a dynamic tool file.
// 2. eve's `definitions/tools.js#liveTool` converts the resolved tool's input schema with
//    `toInputSchema` (a Standard Schema with an emitter passes through; anything else is re-emitted
//    as plain JSON and loses its own `validate`).
// 3. eve's `harness/tool-call-io.js#checkToolCallInput` validates the call's input against that
//    schema. In the model loop the same check runs in the `ai` SDK's `parseToolCall` (eve builds the
//    tool with `harness/model-call/tools.js#toModelSchema`), and eve drops an invalid call before
//    `decideApproval`. `checkToolCallInput` is that check on the programmatic and deferred routes.
// 4. eve calls the resolved tool's `execute` with the validated value.
//
// The model-facing schema is eve's `serializeModelInputSchema` of the step-2 schema.

export const TOOL_CALL_IO_PATH = "dist/src/harness/tool-call-io.js";

type CheckResult = { readonly kind: "valid"; readonly value: unknown } | { readonly kind: "invalid"; readonly message: string } | { readonly kind: "threw"; readonly error: unknown };

interface EveToolPath {
  readonly toInputSchema: (schema: unknown) => unknown;
  readonly serializeModelInputSchema: (schema: unknown) => unknown;
  readonly checkToolCallInput: (tool: { name: string; inputSchema: unknown }, input: unknown, callId: string) => Promise<CheckResult>;
}

async function loadEveToolPath(): Promise<EveToolPath> {
  const root = installedEveRoot(import.meta.url);
  const helpers = await readEveSchemaHelpers(root);
  const schema = (await import(pathToFileURL(join(root, SCHEMA_PATH)).href)) as Record<string, unknown>;
  const io = (await import(pathToFileURL(join(root, TOOL_CALL_IO_PATH)).href)) as Record<string, unknown>;
  for (const [mod, name, path] of [
    [schema, "serializeModelInputSchema", SCHEMA_PATH],
    [io, "checkToolCallInput", TOOL_CALL_IO_PATH],
  ] as const) {
    if (typeof mod[name] !== "function") throw new Error(`eve's ${path} no longer exports \`${name}\`. Re-read eve's tool-call path and update scripts/_eve-tool-path.ts.`);
  }
  return {
    toInputSchema: helpers.toInputSchema,
    serializeModelInputSchema: schema.serializeModelInputSchema as EveToolPath["serializeModelInputSchema"],
    checkToolCallInput: io.checkToolCallInput as EveToolPath["checkToolCallInput"],
  };
}

const eve = await loadEveToolPath();

const DYNAMIC = Symbol.for("eve.dynamic");

/** Evaluates the roster shim `seatCut(name, tool)` as eve evaluates a dynamic tool file. */
export async function resolveThroughSeatCut(name: string, tool: unknown, ctx: unknown = { session: { id: "wrun_EVE_TOOL_PATH" } }): Promise<unknown> {
  const sentinel = seatCut(name, tool) as Record<symbol, (c: unknown) => unknown>;
  return await sentinel[DYNAMIC]!(ctx);
}

export interface EveToolCall {
  /** False when the seat cut returned no tool: the model is never offered it. */
  readonly offered: boolean;
  /** True when the tool's real execute ran. */
  readonly ran: boolean;
  /** What execute received, when it ran. */
  readonly received: unknown;
  /** The validation message, or the execute error's message. */
  readonly error: string | undefined;
  /** True when the refusal came from input validation (before approval and execute). */
  readonly refusedAtValidation: boolean;
  /** The JSON Schema the model is offered. */
  readonly modelSchema: unknown;
}

/** The model-facing JSON Schema of an already resolved tool, as eve offers it. */
export function modelSchemaOf(resolved: unknown): unknown {
  const runtime = eve.toInputSchema((resolved as { inputSchema?: unknown }).inputSchema);
  return eve.serializeModelInputSchema(runtime);
}

/**
 * Drives one call to the tool `name` along the eve 1.x path. `tool` is the authored tool (its
 * execute should set a flag; `ran` reports the real execute through `onRun`). With
 * `bypassSeatCut`, the tool skips step 1: the NEGATIVE CONTROL for "the seat cut is the caller".
 */
export async function driveEveToolCall(
  name: string,
  tool: { execute?: (input: unknown, opts?: unknown) => unknown; [key: string]: unknown },
  input: unknown,
  opts: { readonly bypassSeatCut?: boolean } = {},
): Promise<EveToolCall> {
  let ran = false;
  let received: unknown = undefined;
  const inner = tool.execute;
  const authored = {
    ...tool,
    execute: async (value: unknown, options?: unknown) => {
      ran = true;
      received = value;
      return inner === undefined ? "ok" : await inner(value, options);
    },
  };
  const resolved = opts.bypassSeatCut === true ? authored : await resolveThroughSeatCut(name, authored);
  if (resolved === null || resolved === undefined) {
    return { offered: false, ran, received, error: undefined, refusedAtValidation: false, modelSchema: undefined };
  }
  const live = resolved as { inputSchema?: unknown; execute: (input: unknown, opts: unknown) => unknown };
  const runtime = eve.toInputSchema(live.inputSchema);
  const modelSchema = eve.serializeModelInputSchema(runtime);
  const check = await eve.checkToolCallInput({ name, inputSchema: runtime }, input, "c1");
  if (check.kind === "invalid") return { offered: true, ran, received, error: check.message, refusedAtValidation: true, modelSchema };
  if (check.kind === "threw") throw check.error;
  try {
    await live.execute(check.value, { toolCallId: "c1", messages: [] });
    return { offered: true, ran, received, error: undefined, refusedAtValidation: false, modelSchema };
  } catch (err) {
    return { offered: true, ran, received, error: err instanceof Error ? err.message : String(err), refusedAtValidation: false, modelSchema };
  }
}
