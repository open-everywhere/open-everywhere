import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { asSchema, generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { FRESH_EYES_REVIEW_OUTPUT, modelFacingOutputSchema } from "../agent/subagents/contracts.js";
import { allowsNull, nullableOptionalSchema, optionalNonNullablePaths } from "../agent/access/nullable-optional-fields.js";
import { postPrWalkthroughEntry } from "../agent/tools/post_pr_walkthrough.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

type Json = Record<string, unknown>;
const require = createRequire(import.meta.url);
const eveRoot = require.resolve("eve/package.json").replace(/package\.json$/, "");
const eveSchema = (await import(`${eveRoot}dist/src/tools/schema.js`)) as {
  serializeOutputSchema(schema: unknown): Json;
  toInputSchema(schema: unknown): unknown;
};
const eveFinal = (await import(`${eveRoot}dist/src/harness/final-output.js`)) as {
  FINAL_OUTPUT_TOOL_NAME: string;
  buildFinalOutputTool(schema: Json): Record<string, unknown>;
};

const wrapped = modelFacingOutputSchema(FRESH_EYES_REVIEW_OUTPUT);
const loweredWrapped = eveSchema.serializeOutputSchema(wrapped);
const loweredRaw = eveSchema.serializeOutputSchema(FRESH_EYES_REVIEW_OUTPUT);

const verdict = (finding: Json, extra: Json = {}): Json => ({
  recommendation: "approve",
  summary: "s",
  evidenceSeen: true,
  findings: [{ severity: "nit", category: "docs", title: "t", detail: "d", ...finding }],
  ...extra,
});

console.log("1. eve's lowering of the contract:");
eq(optionalNonNullablePaths(loweredRaw).sort(), ["findings[].location", "meaning"], "§1 CONTROL: the RAW contract lowers with two optional non-nullable fields — the slots the model fills with an invented value");
eq(optionalNonNullablePaths(loweredWrapped), [], "🔴 §1 the WRAPPED contract lowers with NO optional non-nullable field");
const props = (loweredWrapped.properties ?? {}) as Record<string, Json>;
const findingProps = ((props.findings?.items as Json | undefined)?.properties ?? {}) as Record<string, Json>;
ok(allowsNull(findingProps.location) && allowsNull(props.meaning), "§1 findings[].location and meaning allow null");
for (const key of ["recommendation", "summary", "evidenceSeen", "findings"]) ok(allowsNull(props[key]) === false, `🔴 §1 NEGATIVE CONTROL: the required field \`${key}\` is NOT nullable`);
for (const key of ["severity", "category", "title", "detail"]) ok(allowsNull(findingProps[key]) === false, `§1 NEGATIVE CONTROL: the required finding field \`${key}\` is NOT nullable`);

console.log("2. final_output tool call:");
async function finalOutputCall(lowered: Json, input: Json): Promise<{ input: unknown; invalid: boolean }> {
  const tools = { [eveFinal.FINAL_OUTPUT_TOOL_NAME]: eveFinal.buildFinalOutputTool(lowered) };
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: eveFinal.FINAL_OUTPUT_TOOL_NAME, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
      warnings: [],
    }),
  } as never) as unknown as LanguageModel;
  const result = await generateText({ model, prompt: "go", tools: tools as ToolSet, stopWhen: stepCountIs(1) });
  const call = result.toolCalls[0] as { input: unknown; invalid?: boolean } | undefined;
  return { input: call?.input, invalid: call === undefined || call.invalid === true };
}
const nulls = verdict({ location: null }, { meaning: null });
const onWrapped = await finalOutputCall(loweredWrapped, nulls);
ok(onWrapped.invalid === false, "🔴 §2 `location: null` + `meaning: null` is a VALID final_output call on the wrapped schema");
const onRaw = await finalOutputCall(loweredRaw, nulls);
ok(onRaw.invalid === true, "§2 CONTROL: the same call is INVALID on the raw schema — the model's only valid move there is to invent a value");
const withValue = await finalOutputCall(loweredWrapped, verdict({ location: "a.ts:1" }));
ok(withValue.invalid === false && (withValue.input as { findings: Json[] }).findings[0]?.location === "a.ts:1", "§2 a real location still passes through unchanged");

console.log("3. the contract's validate:");
const validate = (v: unknown) => wrapped["~standard"].validate(v) as { value?: unknown; issues?: unknown };
const stripped = validate(nulls);
ok(stripped.issues === undefined, "🔴 §3 the wrapped contract ACCEPTS `location: null` + `meaning: null`");
const finding = ((stripped.value as { findings: Json[] }).findings[0] ?? {}) as Json;
ok(!("location" in finding), "🔴 §3 …and the contract consumer receives `location` ABSENT, not null");
ok(!("meaning" in (stripped.value as Json)), "§3 …and `meaning` absent");
ok(FRESH_EYES_REVIEW_OUTPUT.safeParse(nulls).success === false, "§3 CONTROL: the RAW contract rejects the same nulls — the strip is what makes it pass");
ok(validate(verdict({}, { summary: null })).issues !== undefined, "🔴 §3 NEGATIVE CONTROL: a null REQUIRED field still fails validation");

console.log("4. post_pr_walkthrough narration:");
const postDef = postPrWalkthroughEntry as unknown as { inputSchema: unknown };
const postSchema = nullableOptionalSchema(postDef.inputSchema);
ok(postSchema !== undefined, "§4 the OPE-2068 seam rewrites post_pr_walkthrough's input schema");
const parsed = (await asSchema(postSchema as never).validate!({ repo: "o/r", number: 1, narration: nulls, factsRunId: null })) as { success: boolean; value?: { narration: { findings: Json[]; meaning?: unknown } } };
ok(parsed.success === true, "§4 a narration copied with `location: null` validates");
ok(parsed.success === true && !("location" in (parsed.value!.narration.findings[0] ?? {})), "🔴 §4 …and reaches the tool with `location` absent");

console.log(`\nsubagent-output-nullable: ${n} assertions passed`);
