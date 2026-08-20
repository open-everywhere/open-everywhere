import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const require_ = createRequire(import.meta.url);
const eveRoot = dirname(require_.resolve("eve/package.json"));
const distSrc = `${eveRoot}/dist/src`;
const u = (rel: string): string => pathToFileURL(`${distSrc}/${rel}`).href;

const { defineTool } = (await import(u("public/tools/index.js"))) as {
  defineTool<T extends Record<string, unknown>>(entry: T): T;
};
const lifecycle = (await import(u("context/dynamic-tool-lifecycle.js"))) as {
  dispatchDynamicToolEvent(e: unknown): Promise<void>;
  hydrateDynamicSessionTools(e: unknown): Promise<void>;
  replayDynamicSessionTools(meta: readonly unknown[]): { name: string; execute: unknown }[];
};
const keys = (await import(u("context/keys.js"))) as { SessionIdKey: unknown; SessionDynamicToolMetadataKey: unknown };
const { dispatchDynamicToolEvent, hydrateDynamicSessionTools, replayDynamicSessionTools } = lifecycle;
const { SessionIdKey, SessionDynamicToolMetadataKey } = keys;

const REG_SYMBOL = Symbol.for("@workflow/core//registeredSteps");
const registry = (): Map<string, unknown> => (globalThis as Record<symbol, unknown>)[REG_SYMBOL] as Map<string, unknown>;

interface FakeCtx {
  get(k: unknown): unknown;
  set(k: unknown, v: unknown): void;
  require(k: unknown): unknown;
}
function makeCtx(sessionId: string): FakeCtx {
  const store = new Map<unknown, unknown>();
  store.set(SessionIdKey, sessionId);
  return {
    get: (k) => store.get(k),
    set: (k, v) => {
      store.set(k, v);
    },
    require: (k) => {
      if (!store.has(k)) throw new Error(`ctx.require: missing key ${String(k)}`);
      return store.get(k);
    },
  };
}

interface DurableToolMetaRow {
  readonly name: string;
  readonly executeStepFnName: string;
  readonly approvalStepFnName?: string;
  readonly approvalResponseStepFnName?: string;
  readonly closureVars: unknown;
}

console.log("1. execute-only synthetic tool (no OE stamp):");
{
  let callCount = 0;
  const entry = defineTool({
    description: "synthetic probe tool",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      callCount++;
      return { ok: true, callCount };
    },
  });
  ok(!("__executeStepFn" in entry), "synthetic entry carries no __executeStepFn stamp (simulating retirement)");

  const resolverDescriptor = { slug: "synthetic_probe_tool", eventNames: ["session.started"], events: { "session.started": async () => entry } };
  const ctx = makeCtx("sess-ope867-native-heal-1");
  const event = { type: "session.started" };

  await dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  const metadata = ctx.get(SessionDynamicToolMetadataKey) as DurableToolMetaRow[];
  ok(Array.isArray(metadata) && metadata.length === 1, "session.started resolve stored ONE durable metadata row");
  const row = metadata[0]!;
  ok(
    row.executeStepFnName.startsWith("eve:framework-dynamic:sess-ope867-native-heal-1:synthetic_probe_tool:"),
    `eve derived a SESSION-SCOPED stable step id (${row.executeStepFnName}) — sessionId embedded, no build-order counter`,
  );
  ok(typeof registry().get(row.executeStepFnName) === "function", "warm path: step fn IS registered in the process registry right after resolve");

  (globalThis as Record<symbol, unknown>)[REG_SYMBOL] = new Map();
  ok(registry().size === 0, "registry wiped (cold-start simulation)");
  const skipped = replayDynamicSessionTools(metadata);
  ok(skipped.length === 0, "RED: cold-resumed replay SKIPS the tool with the registry empty and no healing");

  await hydrateDynamicSessionTools({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  ok(typeof registry().get(row.executeStepFnName) === "function", "GREEN: hydrateDynamicSessionTools re-registered the SAME deterministic step id after a simulated cold start");

  const replayed = replayDynamicSessionTools(metadata);
  ok(replayed.length === 1 && replayed[0]!.name === "synthetic_probe_tool", "post-heal replay returns the tool (not skipped)");
  const stepFn = registry().get(row.executeStepFnName) as (cv: unknown, input: unknown, ctx: unknown) => Promise<{ ok: boolean; callCount: number }>;
  const result = await stepFn(row.closureVars, {}, {});
  ok(result.ok === true && result.callCount === 1, "post-heal registered step fn IS the SAME original closure (callCount incremented once, not a mismatched tool)");
}

console.log("2. approval-bearing synthetic tool (OPE-575 response-half):");
{
  const entry = defineTool({
    description: "synthetic approval probe",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
    approval: {
      request: async () => "user-approval",
      response: async () => ({ status: "approved", reason: "probe" }),
    },
  });
  const resolverDescriptor = { slug: "synthetic_probe_approval_tool", eventNames: ["session.started"], events: { "session.started": async () => entry } };
  const ctx = makeCtx("sess-ope867-native-heal-2");
  const event = { type: "session.started" };
  await dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  const metadata = ctx.get(SessionDynamicToolMetadataKey) as DurableToolMetaRow[];
  const row = metadata[0]!;
  ok(typeof row.approvalStepFnName === "string" && typeof row.approvalResponseStepFnName === "string", "approval + approval-response step names both derived");

  (globalThis as Record<symbol, unknown>)[REG_SYMBOL] = new Map();
  await hydrateDynamicSessionTools({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  ok(typeof registry().get(row.approvalStepFnName!) === "function", "GREEN: approval REQUEST step healed after simulated cold start");
  ok(
    typeof registry().get(row.approvalResponseStepFnName!) === "function",
    "GREEN: approval RESPONSE step healed after simulated cold start (OPE-575's reject-all degradation does not trigger)",
  );
}

console.log(`\ndynamic-tool-native-heal: ${n} assertions passed.`);
