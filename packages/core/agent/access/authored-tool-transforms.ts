import { outboundInputRefusal, outboundSinkOf, type OutboundFilterDeps } from "./outbound-filter.js";
import { nullableOptionalJsonSchema, stripAddedNulls } from "./nullable-optional-fields.js";
import { currentTestRun, noteTestRunBlocked } from "./test-run-state.js";
import { recordBlockedCall, type BlockedCallRecorder } from "./test-run-fence.js";
import { testRunBlockedMessage, testRunToolVerdict } from "../routines/test-run.js";

/**
 * The tool transforms for eve 1.x, applied to ONE authored tool. The seat cut
 * (`seat-cut.ts#cutResolvedTools`) calls this module, so every roster tool shim that passes through
 * `seatCut` carries the transforms.
 *
 * Three transforms:
 *
 * - **The outbound sensitive-data filter.** A call to an outbound sink whose input carries a card
 *   number, a government ID number or a secret is withheld; health and financial data are held until
 *   a member asks. The decision is `outbound-filter.ts#outboundInputRefusal`.
 * - **The nullable-optional rewrite.** Each optional property is advertised as nullable, and a null
 *   the model sends for it is stripped before the tool's own validation.
 * - **The test-run fence.** Inside a routine test run, a tool that `testRunToolVerdict` blocks never
 *   reaches its real execute.
 *
 * eve 1.x keeps an authored input schema only when it is a Standard Schema with a JSON Schema
 * emitter (`isToolSchema` in eve's `tools/schema.js`). It re-emits any other schema as plain JSON
 * and drops its `validate` function. So the 0.71 wrap (an `ai` `jsonSchema()` with a `validate`)
 * would never run here. This module returns its own Standard Schema instead. In the model loop, the
 * `ai` SDK's `parseToolCall` validates a call's input against it (eve builds the tool with
 * `harness/model-call/tools.js#toModelSchema`), and eve drops an invalid call before
 * `decideApproval`. The programmatic and deferred routes run the same check
 * (`harness/tool-call-io.js#checkToolCallInput`). So a refused call posts no approval card and runs
 * nothing.
 *
 * A tool whose schema is NOT a Standard Schema with an emitter (a plain JSON Schema, such as an
 * OE-owned connector tool's listed schema) keeps its schema, so eve's own validator still runs. The
 * outbound filter then runs at execute instead, and the nullable rewrite does not apply. An outbound
 * sink that this module can wrap neither way is withheld from the seat: the filter fails closed.
 *
 * The module never mutates the authored tool object. That object is a module-level constant shared
 * by every session, so each transform returns a copy.
 */

const STANDARD = "~standard";
const TRANSFORMED = Symbol.for("open-everywhere.authored-tool-transforms");
const WORKFLOW_TOOL_BRAND = Symbol.for("eve:workflow-tool-brand");

type Json = Record<string, unknown>;

type StandardResult = { readonly value: unknown; readonly issues?: undefined } | { readonly issues: readonly { readonly message: string }[] };

interface StandardProps {
  readonly vendor?: unknown;
  readonly validate: (value: unknown) => StandardResult | Promise<StandardResult>;
  readonly jsonSchema?: { readonly input?: (opts: unknown) => unknown; readonly output?: (opts: unknown) => unknown };
}

export interface AuthoredToolTransformDeps extends OutboundFilterDeps {
  readonly recordBlocked?: BlockedCallRecorder;
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function standardOf(schema: unknown): StandardProps | undefined {
  if (!isRecord(schema)) return undefined;
  const props = schema[STANDARD];
  if (!isRecord(props) || typeof props.validate !== "function") return undefined;
  const emit = props.jsonSchema;
  if (!isRecord(emit) || typeof emit.input !== "function") return undefined;
  return props as unknown as StandardProps;
}

function emitted(props: StandardProps, side: "input" | "output"): Json {
  const emitter = props.jsonSchema?.[side] ?? props.jsonSchema?.input;
  const raw = emitter!({ target: "draft-07" });
  const json = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!isRecord(json)) throw new TypeError("the schema emitter returned no JSON object");
  const { $schema: _version, ...rest } = json;
  return rest;
}

const wrapped = new WeakMap<object, Map<string, object>>();
const ours = new WeakSet<object>();

/** True when `schema` is a schema this module returned. */
function isAuthoredInputSchema(schema: unknown): boolean {
  return isRecord(schema) && ours.has(schema);
}

/**
 * The Standard Schema that carries the outbound filter and the nullable-optional rewrite for the tool
 * `name`. It returns `undefined` when `source` is not a Standard Schema with a JSON emitter, and the
 * same object for the same source and name. It throws when the source's emitter throws.
 */
export function authoredInputSchema(name: string, source: unknown, deps: OutboundFilterDeps = {}): object | undefined {
  if (isAuthoredInputSchema(source)) return source as object;
  const props = standardOf(source);
  if (props === undefined) return undefined;
  const key = source as object;
  // The cache holds production wrappers only. A wrapper closes over its deps, so a call with its own
  // deps (a test's recorder or ask list) gets a fresh wrapper and never a cached one.
  const cacheable = deps.record === undefined && deps.asked === undefined;
  const cached = cacheable ? wrapped.get(key)?.get(name) : undefined;
  if (cached !== undefined) return cached;

  const sourceJson = emitted(props, "input");
  const advertisedInput = nullableOptionalJsonSchema(sourceJson) as Json;
  const advertisedOutput = props.jsonSchema?.output === undefined ? advertisedInput : (nullableOptionalJsonSchema(emitted(props, "output")) as Json);
  const filters = outboundSinkOf(name) === "outbound";

  const replacement = {
    [STANDARD]: {
      version: 1,
      vendor: "open-everywhere",
      validate: async (value: unknown): Promise<StandardResult> => {
        if (filters) {
          const refusal = await outboundInputRefusal(name, value, deps);
          if (refusal !== undefined) return { issues: [{ message: refusal.message }] };
        }
        return await props.validate(stripAddedNulls(sourceJson, value));
      },
      jsonSchema: {
        input: () => structuredClone(advertisedInput),
        output: () => structuredClone(advertisedOutput),
      },
    },
  };
  ours.add(replacement);
  if (cacheable) {
    const byName = wrapped.get(key) ?? new Map<string, object>();
    byName.set(name, replacement);
    wrapped.set(key, byName);
  }
  return replacement;
}

interface ToolLike {
  inputSchema?: unknown;
  execute?: (...args: unknown[]) => unknown;
}

function copyOf(tool: object): ToolLike {
  const copy = Object.create(Object.getPrototypeOf(tool) as object | null, Object.getOwnPropertyDescriptors(tool)) as ToolLike;
  Object.defineProperty(copy, TRANSFORMED, { value: true });
  return copy;
}

/** True when `tool` is a copy this module returned. */
export function isTransformedAuthoredTool(tool: unknown): boolean {
  return isRecord(tool) && (tool as Record<symbol, unknown>)[TRANSFORMED] === true;
}

function warnWithheld(name: string, why: string): void {
  console.warn(`[open-everywhere:outbound-filter] withheld "${name}" from the seat: ${why}`);
}

/**
 * One authored tool with the transforms applied: a copy, never the authored object. It returns
 * `null` when the seat must not hold the tool: an outbound sink the filter cannot reach, or, inside a
 * test run, a blocked tool with no execute to fence.
 */
export function transformAuthoredTool(name: string, tool: unknown, deps: AuthoredToolTransformDeps = {}): unknown {
  if (!isRecord(tool)) return tool;
  if (isTransformedAuthoredTool(tool)) return tool;
  const copy = copyOf(tool);
  const sink = outboundSinkOf(name) === "outbound";

  let schema: object | undefined;
  try {
    schema = authoredInputSchema(name, copy.inputSchema, deps);
  } catch (err) {
    if (sink) {
      warnWithheld(name, `its input schema could not be wrapped (${err instanceof Error ? err.name : "error"})`);
      return null;
    }
  }
  if (schema !== undefined) copy.inputSchema = schema;

  // A workflow tool's entry point carries its compiled workflow id, and eve dispatches the workflow
  // instead of calling execute. A wrap would hide that id, so a workflow tool takes the no-execute arm.
  const workflow = (tool as Record<symbol, unknown>)[WORKFLOW_TOOL_BRAND] === true;
  const inner = !workflow && typeof tool.execute === "function" ? (tool.execute as (...args: unknown[]) => unknown) : undefined;
  if (inner === undefined) {
    if (sink && schema === undefined) {
      warnWithheld(name, "it has no Standard Schema input and no execute, so the outbound filter cannot reach it");
      return null;
    }
    const stamp = currentTestRun();
    if (stamp !== null && testRunToolVerdict(name) === "block") return null;
    return copy;
  }

  const filterAtExecute = sink && schema === undefined;
  const recordBlocked = deps.recordBlocked ?? recordBlockedCall;
  copy.execute = async (...args: unknown[]) => {
    const input = args[0];
    const stamp = currentTestRun();
    if (stamp !== null && testRunToolVerdict(name, input) === "block") {
      noteTestRunBlocked();
      await recordBlocked(stamp, name, input);
      throw new Error(testRunBlockedMessage(name));
    }
    if (filterAtExecute) {
      const refusal = await outboundInputRefusal(name, input, deps);
      if (refusal !== undefined) throw refusal;
    }
    return await inner.apply(tool, args);
  };
  return copy;
}

/**
 * Applies `transformAuthoredTool` to every entry of `toolset` in place: each entry becomes its copy,
 * and an entry the seat must not hold is deleted. It returns the deleted names.
 */
export function transformAuthoredToolset(toolset: Record<string, unknown>, deps: AuthoredToolTransformDeps = {}): string[] {
  const withheld: string[] = [];
  for (const [name, tool] of Object.entries(toolset)) {
    const next = transformAuthoredTool(name, tool, deps);
    if (next === null) {
      delete toolset[name];
      withheld.push(name);
    } else {
      toolset[name] = next;
    }
  }
  return withheld;
}
