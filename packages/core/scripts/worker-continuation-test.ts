import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { asSchema } from "ai";

import {
  CONTINUATION_REFUSAL_MESSAGE,
  refuseAgentContinuation,
  suppressAgentsListing,
} from "../agent/access/worker-continuation.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = require.resolve("eve/package.json").replace(/package\.json$/, "");
const registry = (await import(`${eveRoot}dist/src/runtime/subagents/registry.js`)) as {
  getSubagentToolInputJsonSchema(persistent: boolean): unknown;
};
const toolSchema = (await import(`${eveRoot}dist/src/shared/tool-schema.js`)) as { toInputSchema(schema: unknown): unknown };

const persistentSchema = () => toolSchema.toInputSchema(registry.getSubagentToolInputJsonSchema(true));
const plainSchema = () => toolSchema.toInputSchema(registry.getSubagentToolInputJsonSchema(false));

const advertised = (schema: unknown): Record<string, unknown> =>
  (asSchema(schema as never).jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};

ok("agentId" in advertised(persistentSchema()), "§0 eve's PERSISTENT subagent schema really does advertise `agentId` — the premise this control exists for");
ok(!("agentId" in advertised(plainSchema())), "§0 eve's non-persistent schema does NOT — which is why the flag-off arm needs no flag read");

const agentsNote = { role: "user", content: '[Agents]\n<agents>\n<agent id="ag_1:abc" name="worker" availability="available">(available)</agent>\n</agents>' };
const messages: unknown[] = [
  { role: "system", content: "you are a seat" },
  { role: "user", content: "find the invoice" },
  { role: "assistant", content: "on it" },
  agentsNote,
];
const removed = suppressAgentsListing(messages);
eq(removed, 1, "🔴 §1 the listing is removed — this is the whole model-context half of the refusal posture");
eq(messages.length, 3, "…and exactly one message went");
ok(!messages.includes(agentsNote), "…and it was THAT message");
eq(
  messages.map((m) => (m as { content?: unknown }).content),
  ["you are a seat", "find the invoice", "on it"],
  "🔴 §1 NEGATIVE CONTROL: every other message survives, in order — an over-eager splice would silently drop the conversation",
);

const twoNotes: unknown[] = [agentsNote, { role: "user", content: "hi" }, { ...agentsNote }];
eq(suppressAgentsListing(twoNotes), 2, "§1 every listing in the array goes, not just the last");
eq(twoNotes.length, 1, "…leaving only the real message");

const nearMisses: unknown[] = [
  { role: "user", content: "[Agents] are what we call the workers" },
  { role: "user", content: "<agents>\n</agents>" },
  { role: "assistant", content: '[Agents]\n<agents>\n</agents>' },
  { role: "user", content: 42 },
  null,
];
eq(suppressAgentsListing(nearMisses), 0, "🔴 §1 NEGATIVE CONTROL: four near-misses and a null are all KEPT — only eve's own two-line render matches");
eq(nearMisses.length, 5, "…the array is untouched");

eq(suppressAgentsListing(undefined), 0, "§1 no messages ⇒ 0, never a throw (the resolver turns a throw into a failed model call)");
eq(suppressAgentsListing("[Agents]"), 0, "§1 a non-array ⇒ 0");

const persistentToolset = () => ({ agent: { inputSchema: persistentSchema() }, bash: { inputSchema: plainSchema() } });

const armed = persistentToolset();
const beforeAgentSchema = armed.agent.inputSchema;
const bashSchemaBeforeRefusal = armed.bash.inputSchema;
eq(refuseAgentContinuation(armed as Record<string, unknown>), true, "🔴 §2 the `agent` tool IS replaced on a persistent-session build");
ok(armed.agent.inputSchema !== beforeAgentSchema, "…and the tool now carries a DIFFERENT schema object");
ok(!("agentId" in advertised(armed.agent.inputSchema)), "🔴 §2 `agentId` is GONE from the advertised schema — the model is not offered the field");
ok("message" in advertised(armed.agent.inputSchema), "…while every other field eve advertises survives (a wholesale replacement would break delegation)");
ok("outputSchema" in advertised(armed.agent.inputSchema), "…including the structured-output field");

const validate = asSchema(armed.agent.inputSchema as never).validate;
ok(typeof validate === "function", "§3 the replacement carries a validate — without one there is no refusal, only absence");

const refused = await validate!({ message: "keep going", agentId: "ag_1:abc" });
eq(refused.success, false, "🔴 §3 a call carrying an `agentId` is REFUSED — this is the assertion the whole ticket rests on");
eq(
  (refused as { error?: Error }).error?.message,
  CONTINUATION_REFUSAL_MESSAGE,
  "…with OE's own posture message, not a generic schema complaint — the seat has to be told WHY and what to do instead",
);
ok(/not accepted/.test(CONTINUATION_REFUSAL_MESSAGE), "§3 the message states the refusal");
ok(/fresh delegation/.test(CONTINUATION_REFUSAL_MESSAGE), "§3 …and names the route that replaces it, so the refusal cannot become a retry loop");

const allowed = await validate!({ message: "find the invoice" });
eq(allowed.success, true, "🔴 §3 NEGATIVE CONTROL: an ordinary delegation still validates — the refusal is scoped to the continuation field");
eq((allowed as { value?: unknown }).value, { message: "find the invoice" }, "…and its input reaches eve unchanged");

for (const blank of [null, "", "   "]) {
  const r = await validate!({ message: "go", agentId: blank });
  eq(r.success, true, `§3 \`agentId: ${JSON.stringify(blank)}\` is eve's own spelling of "omitted" and is NOT a refusal`);
  eq((r as { value?: unknown }).value, { message: "go" }, "…and the key is dropped, so no downstream reader sees a continuation id");
}

for (const weird of [1, { id: "x" }, true, ["ag_1"]]) {
  const r = await validate!({ message: "go", agentId: weird });
  eq(r.success, false, `🔴 §3 a non-string \`agentId\` (${JSON.stringify(weird)}) is REFUSED — the fail-closed direction`);
}

const missing = await validate!({});
eq(missing.success, false, "🔴 §3 eve's OWN validation still runs — the replacement adds a rule, it does not become the rule");
ok(
  (missing as { error?: Error }).error?.message !== CONTINUATION_REFUSAL_MESSAGE,
  "…and a schema error is reported as one, not mislabelled as a continuation refusal",
);

const twice = armed.agent.inputSchema;
eq(refuseAgentContinuation(armed as Record<string, unknown>), false, "§2 a second pass over an already guarded tool does nothing — the field it looks for is already gone");
ok(armed.agent.inputSchema === twice, "…and leaves the SAME schema object in place, so no wrapper stacks");
const stillRefuses = await asSchema(armed.agent.inputSchema as never).validate!({ message: "keep going", agentId: "ag_1:abc" });
eq(stillRefuses.success, false, "…and the guard still refuses after the second pass");

const sharedOriginal = persistentSchema();
const callOne = { agent: { inputSchema: sharedOriginal } };
const callTwo = { agent: { inputSchema: sharedOriginal } };
refuseAgentContinuation(callOne as Record<string, unknown>);
refuseAgentContinuation(callTwo as Record<string, unknown>);
ok(callOne.agent.inputSchema === callTwo.agent.inputSchema, "🔴 §2 one original schema ⇒ one replacement, reused — the advertised bytes are stable turn to turn");

const off = { agent: { inputSchema: plainSchema() } };
const offSchema = off.agent.inputSchema;
eq(refuseAgentContinuation(off as Record<string, unknown>), false, "🔴 §4 eve's non-persistent schema has no `agentId`, so nothing is replaced — the flag-off arm is byte-identical WITHOUT a flag read");
ok(off.agent.inputSchema === offSchema, "…the tool object is untouched, down to schema identity");

eq(refuseAgentContinuation({ bash: { inputSchema: plainSchema() } }), false, "§4 no `agent` tool ⇒ no-op");
eq(refuseAgentContinuation({}), false, "§4 an empty toolset ⇒ no-op");
eq(refuseAgentContinuation({ agent: null } as unknown as Record<string, unknown>), false, "§4 a null entry ⇒ no-op, never a throw");
eq(refuseAgentContinuation({ agent: {} }), false, "§4 a tool with no input schema ⇒ no-op");

ok(armed.bash.inputSchema === bashSchemaBeforeRefusal, "§4 no tool but `agent` is inspected or replaced");

console.log(`worker-continuation: ${n} assertions passed`);
