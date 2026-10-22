import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-nullable-optional-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { asSchema, generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

import { projectToolSet } from "../agent/access/untrusted-projection.js";
import { optionalNonNullablePaths, allowsNull, nullableOptionalSchema } from "../agent/access/nullable-optional-fields.js";
import { registeredMountedEntries } from "../agent/access/window-gated.js";
import { registerBrowserToolkit } from "../agent/access/browser-toolkit.js";
import setSpendLimit, { planSetSpendLimit } from "../agent/tools/set_spend_limit.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = require.resolve("eve/package.json").replace(/package\.json$/, "");
const eveRootUrl = pathToFileURL(eveRoot).href;
const eveSchema = (await import(`${eveRootUrl}dist/src/tools/schema.js`)) as {
  isToolSchema(schema: unknown): boolean;
  serializeInputSchema(schema: unknown): unknown;
  toInputSchema(schema: unknown): unknown;
};
const staticRuntimeSchema = (s: unknown): unknown => (eveSchema.isToolSchema(s) ? s : eveSchema.toInputSchema(eveSchema.serializeInputSchema(s)));
const replayedRuntimeSchema = (s: unknown): unknown => eveSchema.toInputSchema(eveSchema.serializeInputSchema(s));

type Json = Record<string, unknown>;
const advertised = async (schema: unknown): Promise<Json> => (await asSchema(schema as never).jsonSchema) as Json;
const props = async (schema: unknown): Promise<Record<string, Json>> => ((await advertised(schema)).properties ?? {}) as Record<string, Json>;

const spendDef = setSpendLimit as unknown as { description: string; inputSchema: unknown };

async function driveToolCall(inputSchema: unknown, input: Json, project: boolean): Promise<{ received: unknown; modelTools: unknown; error: unknown }> {
  let received: unknown = undefined;
  let modelTools: unknown = undefined;
  const toolset: Record<string, unknown> = {
    probe: tool({ description: "probe", inputSchema: inputSchema as never, execute: async (args: unknown) => { received = args; return "ok"; } }),
  };
  if (project) projectToolSet(toolset);
  let step = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { tools?: unknown }) => {
      step++;
      if (step === 1) modelTools = options.tools;
      const content = step === 1 ? [{ type: "tool-call" as const, toolCallId: "c1", toolName: "probe", input: JSON.stringify(input) }] : [{ type: "text" as const, text: "done" }];
      return {
        content,
        finishReason: { unified: step === 1 ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
        usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
        warnings: [],
      };
    },
  } as never) as unknown as LanguageModel;
  const result = await generateText({ model, prompt: "go", tools: toolset as ToolSet, stopWhen: stepCountIs(2) });
  const errorPart = result.steps.flatMap((s) => s.content).find((p) => (p as { type: string }).type === "tool-error") as { error?: unknown } | undefined;
  return { received, modelTools, error: errorPart?.error };
}

const modelFacingProps = (modelTools: unknown): Record<string, Json> => {
  const probe = (modelTools as { name: string; inputSchema: Json }[]).find((t) => t.name === "probe");
  return ((probe?.inputSchema ?? {}) as Json).properties as Record<string, Json>;
};

console.log("1. set_spend_limit model-facing schema:");
const spendSchema = staticRuntimeSchema(spendDef.inputSchema);
const before = await props(spendSchema);
ok(!allowsNull(before.monthlyTokens) && !allowsNull(before.monthlyUsd), "§1 PREMISE: without the seam, monthlyTokens and monthlyUsd do not allow null — the slots the model fills with an invented value");

const probeRun = await driveToolCall(spendSchema, { monthlyUsd: 1609, reason: "x" }, true);
const wire = modelFacingProps(probeRun.modelTools);
ok(allowsNull(wire.monthlyTokens), "🔴 §1 the tools the model is HANDED mark monthlyTokens nullable");
ok(allowsNull(wire.monthlyUsd), "🔴 §1 …and monthlyUsd");
ok(allowsNull(wire.level) && allowsNull(wire.scopeKey), "§1 …and the other two optional fields (level, scopeKey)");
ok(!allowsNull(wire.reason), "🔴 §1 NEGATIVE CONTROL: the REQUIRED field `reason` is NOT nullable");
eq(JSON.stringify(wire.monthlyTokens?.type), JSON.stringify(["integer", "null"]), "§1 monthlyTokens is emitted as type [\"integer\",\"null\"] — the exact shape the measurement's variant C used");
ok(Array.isArray(wire.level?.enum) && (wire.level.enum as unknown[]).includes(null), "§1 an enum field lists null among its values, so the type and the enum agree");

console.log("2. null is stripped before execute:");
const oneNull = await driveToolCall(spendSchema, { monthlyTokens: null, monthlyUsd: 1609, reason: "x" }, true);
eq(oneNull.error, undefined, "§2 the call validates");
eq(oneNull.received, { monthlyUsd: 1609, reason: "x" }, "🔴 §2 execute receives {monthlyUsd:1609, reason} — the null monthlyTokens is ABSENT, not null");
const unprojected = await driveToolCall(spendSchema, { monthlyTokens: null, monthlyUsd: 1609, reason: "x" }, false);
ok(unprojected.error !== undefined && unprojected.received === undefined, "§2 CONTROL: without the seam the same call FAILS validation — so leg 2's green is the seam's doing");

console.log("3. both caps null reaches the tool's own refusal:");
const bothNull = await driveToolCall(spendSchema, { monthlyTokens: null, monthlyUsd: null, reason: "x" }, true);
eq(bothNull.received, { reason: "x" }, "§3 execute receives {reason} alone");
const binding: SurfaceBinding = {
  org: "acme", platform: "slack", workspace: "T123", surface: "C456", mode: "channel", visibility: "public", trust: "internal", principalId: "U999", target: { channelId: "C456" },
} as SurfaceBinding;
assert.throws(
  () => planSetSpendLimit(binding, bothNull.received as never, { tokens: null, usd: null }, null),
  /set_spend_limit needs monthlyTokens or monthlyUsd\b/,
  "🔴 §3 the tool's own planner refuses the stripped input with its at-least-one-cap error",
);
n++;

console.log("4. negative controls:");
const mixed = z.object({ need: z.string(), clear: z.string().nullable().optional(), opt: z.number().optional() });
const keep = await driveToolCall(mixed, { need: "a", clear: null, opt: null }, true);
eq(keep.received, { need: "a", clear: null }, "🔴 §4 a field that ALREADY allowed null keeps its null (the tool's own meaning); the added-null field goes");
const reqNull = await driveToolCall(mixed, { need: null }, true);
ok(reqNull.error !== undefined && reqNull.received === undefined, "🔴 §4 a REQUIRED field sent as null still FAILS validation — only optional fields are widened");
const allRequired = z.object({ a: z.string(), b: z.number() });
ok(nullableOptionalSchema(allRequired) === undefined, "§4 a schema with no optional field is not rewritten (the module answers undefined)");
const stableToolset: Record<string, unknown> = { t: tool({ description: "t", inputSchema: mixed as never, execute: async () => "ok" }) };
projectToolSet(stableToolset);
const first = (stableToolset.t as { inputSchema: unknown }).inputSchema;
projectToolSet(stableToolset);
ok((stableToolset.t as { inputSchema: unknown }).inputSchema === first, "§4 a second projection keeps the SAME replacement (stable bytes for the prompt cache, no double wrap)");
const sameSource: Record<string, unknown> = { t: tool({ description: "t", inputSchema: mixed as never, execute: async () => "ok" }) };
projectToolSet(sameSource);
ok((sameSource.t as { inputSchema: unknown }).inputSchema === first, "§4 a fresh tool object over the same schema gets the cached replacement");

console.log("5. nesting:");
const nested = z.object({
  outer: z.object({ inner: z.string().optional(), must: z.string() }),
  list: z.array(z.object({ tag: z.string().optional(), id: z.string() })).optional(),
});
const nestedRun = await driveToolCall(nested, { outer: { inner: null, must: "m" }, list: [{ tag: null, id: "1" }, { tag: "t", id: "2" }] }, true);
eq(nestedRun.received, { outer: { must: "m" }, list: [{ id: "1" }, { tag: "t", id: "2" }] }, "§5 nulls inside a nested object and inside array items are stripped");
const nestedWire = modelFacingProps(nestedRun.modelTools);
ok(allowsNull(((nestedWire.outer as Json).properties as Record<string, Json>).inner), "§5 the nested optional field is advertised nullable");
ok(!allowsNull(((nestedWire.outer as Json).properties as Record<string, Json>).must), "§5 NEGATIVE CONTROL: the nested required field is not");

console.log("6. inventory lint over every registered tool:");
registerBrowserToolkit({
  browser_navigate: { description: "fake", inputSchema: {}, execute: () => ({ ok: true }) },
  browser_screenshot: { description: "fake", inputSchema: {}, execute: () => ({ ok: true }) },
});
const inventory: Record<string, unknown> = {};
const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");
for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".ts")).sort()) {
  const mod = (await import(pathToFileURL(join(toolsDir, file)).href)) as { default?: { inputSchema?: unknown } };
  const schema = mod.default?.inputSchema;
  if (schema !== undefined && schema !== null) inventory[`core:${file.replace(/\.ts$/, "")}`] = staticRuntimeSchema(schema);
}
for (const [name, entries] of registeredMountedEntries()) {
  let k = 0;
  for (const entry of entries) {
    const schema = (entry as { inputSchema?: unknown }).inputSchema;
    if (schema !== undefined && schema !== null) inventory[`dynamic:${name}#${k++}`] = replayedRuntimeSchema(schema);
  }
}
const providedDir = join(eveRoot, "dist/src/tools/provided");
for (const file of readdirSync(providedDir).filter((f) => f.endsWith(".js")).sort()) {
  const mod = (await import(pathToFileURL(join(providedDir, file)).href)) as Record<string, unknown>;
  for (const [exportName, value] of Object.entries(mod)) {
    const schema = (value as { inputSchema?: unknown } | null)?.inputSchema;
    if (schema !== undefined && schema !== null && exportName !== "default") inventory[`eve:${file}:${exportName}`] = replayedRuntimeSchema(schema);
  }
}
const names = Object.keys(inventory);
ok(names.filter((k) => k.startsWith("core:")).length >= 30, `§6 the inventory reaches the core static tools (${names.filter((k) => k.startsWith("core:")).length})`);
ok(names.filter((k) => k.startsWith("dynamic:")).length >= 10, `§6 …and the gated dynamic entries (${names.filter((k) => k.startsWith("dynamic:")).length})`);
ok(names.some((k) => k.startsWith("eve:")), "§6 …and eve's framework tools");

const offenders = async (project: boolean): Promise<string[]> => {
  const found: string[] = [];
  for (const [name, schema] of Object.entries(inventory)) {
    const toolset: Record<string, unknown> = { [name]: tool({ description: name, inputSchema: schema as never, execute: async () => "ok" }) };
    if (project) projectToolSet(toolset);
    const json = await advertised((toolset[name] as { inputSchema: unknown }).inputSchema);
    for (const path of optionalNonNullablePaths(json)) found.push(`${name}.${path}`);
  }
  return found;
};
const raw = await offenders(false);
console.log(`   inventory: ${names.length} schemas (core ${names.filter((k) => k.startsWith("core:")).length}, dynamic ${names.filter((k) => k.startsWith("dynamic:")).length}, eve ${names.filter((k) => k.startsWith("eve:")).length}); optional non-nullable without the seam: ${raw.length}; set_spend_limit schema is ${eveSchema.isToolSchema(spendDef.inputSchema) ? "the authored zod" : "eve-rehydrated"}`);
ok(raw.length > 50, `§6 CONTROL: WITHOUT the seam the inventory has ${raw.length} optional non-nullable properties — the lint below measures a real difference`);
ok(raw.includes("core:set_spend_limit.monthlyTokens"), "§6 CONTROL: …set_spend_limit.monthlyTokens among them");
const left = await offenders(true);
eq(left, [], "🔴 §6 WITH the seam no registered tool advertises an optional non-nullable property");

console.log(`\nnullable-optional-fields: ${n} assertions passed`);

// proves: AP-MOD-core-access-nullable-optional-fields
