import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
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
  replayDynamicSessionTools(meta: readonly unknown[], resolvers: readonly unknown[]): { name: string; approval?: unknown }[];
};
const durable = (await import(u("shared/durable-dynamic-tool-callbacks.js"))) as {
  createDurableDynamicCallback<A extends unknown[], R>(i: { closure: Record<string, unknown>; callback: (c: Record<string, unknown>, ...a: A) => R; stepId: string }): (...a: A) => R;
};
const keys = (await import(u("context/keys.js"))) as { SessionIdKey: unknown; SessionDynamicToolMetadataKey: unknown };
const { dispatchDynamicToolEvent, replayDynamicSessionTools } = lifecycle;
const { SessionIdKey, SessionDynamicToolMetadataKey } = keys;

ok(!("hydrateDynamicSessionTools" in lifecycle), "eve 0.44.0 no longer exports hydrateDynamicSessionTools — the durable descriptor replaced it");

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

interface DurableRow {
  readonly name: string;
  readonly callbacks: {
    readonly execute: { readonly stepId: string; readonly closure: Record<string, unknown> };
    readonly approvalRequest?: { readonly stepId: string; readonly closure: Record<string, unknown> };
    readonly approvalResponse?: { readonly stepId: string; readonly closure: Record<string, unknown> };
  };
}

const EXECUTE_STEP = "oe:test:synthetic_probe_tool:execute";

console.log("1. execute-only synthetic tool (durable descriptor contract):");
{
  let callCount = 0;
  const execute = durable.createDurableDynamicCallback<[unknown, unknown], Promise<{ ok: boolean; callCount: number }>>({
    closure: {},
    stepId: EXECUTE_STEP,
    callback: async () => {
      callCount++;
      return { ok: true, callCount };
    },
  });
  const entry = defineTool({ description: "synthetic probe tool", inputSchema: { type: "object", properties: {} }, execute });

  const resolverDescriptor = { slug: "synthetic_probe_tool", eventNames: ["session.started"], events: { "session.started": async () => entry } };
  const event = { type: "session.started" };

  const ctx = makeCtx("sess-ope867-native-heal-1");
  await dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  const metadata = ctx.get(SessionDynamicToolMetadataKey) as DurableRow[];
  ok(Array.isArray(metadata) && metadata.length === 1, "session.started resolve stored ONE durable metadata row");
  const row = metadata[0]!;
  eq(row.callbacks.execute.stepId, EXECUTE_STEP, "the durable row carries the CODE-OWNED step id, not a derived one");
  ok(typeof registry().get(EXECUTE_STEP) === "function", "warm path: the step fn IS in the process registry (the helper registered it at authoring time)");

  const ctx2 = makeCtx("sess-ope867-native-heal-1-other");
  await dispatchDynamicToolEvent({ ctx: ctx2, resolvers: [resolverDescriptor], event, messages: [] });
  const row2 = (ctx2.get(SessionDynamicToolMetadataKey) as DurableRow[])[0]!;
  eq(row2.callbacks.execute.stepId, row.callbacks.execute.stepId, "a DIFFERENT session derives the SAME step id — the id names code, never a session");

  const undescribed = defineTool({
    description: "undescribed probe tool",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  });
  ok(
    (undescribed as Record<symbol, unknown>)[Symbol.for("eve:durable-dynamic-tool-callbacks")] !== undefined,
    "defineTool always stamps the callbacks bag (it is the CONTENTS that decide, so an empty bag is the real negative)",
  );
  const ctxBad = makeCtx("sess-ope867-native-heal-undescribed");
  await dispatchDynamicToolEvent({
    ctx: ctxBad,
    resolvers: [{ slug: "undescribed_probe_tool", eventNames: ["session.started"], events: { "session.started": async () => undescribed } }],
    event,
    messages: [],
  });
  eq(
    (ctxBad.get(SessionDynamicToolMetadataKey) as DurableRow[]).length,
    0,
    "NEGATIVE CONTROL: an entry with an undescribed execute stores NO durable row — eve refuses it rather than mounting a tool it could never replay",
  );

  (globalThis as Record<symbol, unknown>)[REG_SYMBOL] = new Map();
  ok(registry().size === 0, "registry wiped (cold-start simulation)");
  const cold = replayDynamicSessionTools([row], []);
  eq(cold.length, 1, "RED: a cold-resumed replay still MOUNTS the tool (0.44.0 does not drop it silently)");
  ok(registry().get(EXECUTE_STEP) === undefined, "RED: …and its step function is genuinely absent — the tool would throw if called");

  const rebound = durable.createDurableDynamicCallback<[unknown, unknown], Promise<{ ok: boolean; callCount: number }>>({
    closure: {},
    stepId: EXECUTE_STEP,
    callback: async () => {
      callCount++;
      return { ok: true, callCount };
    },
  });
  void rebound;
  ok(typeof registry().get(EXECUTE_STEP) === "function", "GREEN: the module-scope registration puts the SAME step id back after a simulated cold start");
  const replayed = replayDynamicSessionTools([row], []);
  eq(replayed.length === 1 && replayed[0]!.name, "synthetic_probe_tool", "post-heal replay returns the tool under its mounted name");

  const stepFn = registry().get(EXECUTE_STEP) as (cv: unknown, input: unknown, ctx: unknown) => Promise<{ ok: boolean; callCount: number }>;
  const result = await stepFn(row.callbacks.execute.closure, {}, {});
  eq(result, { ok: true, callCount: 1 }, "the restored step fn IS the real closure (its own counter moved), not a mismatched tool");
}

console.log("2. approval-bearing synthetic tool (OPE-575 response-half):");
{
  const REQUEST_STEP = "oe:test:synthetic_probe_approval_tool:approvalRequest";
  const RESPONSE_STEP = "oe:test:synthetic_probe_approval_tool:approvalResponse";
  const EXEC_STEP = "oe:test:synthetic_probe_approval_tool:execute";
  const mk = <A extends unknown[], R>(stepId: string, fn: (...a: A) => R): ((...a: A) => R) =>
    durable.createDurableDynamicCallback<A, R>({ closure: {}, stepId, callback: (_c, ...a: A) => fn(...a) });

  const entry = defineTool({
    description: "synthetic approval probe",
    inputSchema: { type: "object", properties: {} },
    execute: mk(EXEC_STEP, async () => ({ ok: true })),
    approval: {
      request: mk(REQUEST_STEP, async () => "user-approval"),
      response: mk(RESPONSE_STEP, async () => ({ status: "approved", reason: "probe" })),
    },
  });
  const resolverDescriptor = { slug: "synthetic_probe_approval_tool", eventNames: ["session.started"], events: { "session.started": async () => entry } };
  const ctx = makeCtx("sess-ope867-native-heal-2");
  const event = { type: "session.started" };
  await dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  const row = (ctx.get(SessionDynamicToolMetadataKey) as DurableRow[])[0]!;
  eq(row.callbacks.approvalRequest?.stepId, REQUEST_STEP, "the approval REQUEST phase carries its own durable descriptor");
  eq(row.callbacks.approvalResponse?.stepId, RESPONSE_STEP, "…and so does the approval RESPONSE phase (the OPE-575 half)");

  type ApprovalPair = { request(a: unknown): Promise<unknown>; response(a: unknown): Promise<{ status: string; reason?: string }> };
  const healthy = replayDynamicSessionTools([row], [])[0]!.approval as ApprovalPair;
  eq(await healthy.request({}), "user-approval", "replay serves the REAL approval request policy");
  eq(await healthy.response({}), { status: "approved", reason: "probe" }, "replay serves the REAL approval response authorizer");

  registry().delete(RESPONSE_STEP);
  const degraded = replayDynamicSessionTools([row], [])[0]!.approval as ApprovalPair;
  const verdict = await degraded.response({});
  eq(verdict.status, "rejected", "RED: a MISSING approval-response step degrades to reject-everything (OPE-575's hazard, stated by eve itself)");
  ok(String(verdict.reason).includes(RESPONSE_STEP), "…and the refusal names the step id that went missing, so the cause is countable");

  mk(RESPONSE_STEP, async () => ({ status: "approved", reason: "probe" }));
  const restored = replayDynamicSessionTools([row], [])[0]!.approval as ApprovalPair;
  eq(await restored.response({}), { status: "approved", reason: "probe" }, "GREEN: re-registering the response step restores the real authorizer");
}

console.log(`\ndynamic-tool-native-heal: ${n} assertions passed.`);
