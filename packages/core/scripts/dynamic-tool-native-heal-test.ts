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
  refreshDynamicSessionToolsForRuntimeRevision?(i: unknown): Promise<void>;
};
type ReplayFn = (closure: Record<string, unknown>, ...a: unknown[]) => unknown;
const durable = (await import(u("shared/durable-dynamic-tool-callbacks.js"))) as {
  stampDurableDynamicCallback<T extends (...a: never[]) => unknown>(cb: T, d: { callback: ReplayFn; closure: Record<string, unknown> }): T;
  lookupDurableDynamicCallback(toolName: string, phase: string): ReplayFn | undefined;
  hasUnregisteredDurableDynamicCallbacks(meta: readonly { callbacks: Record<string, unknown>; name: string }[]): boolean;
};
const keys = (await import(u("context/keys.js"))) as { SessionIdKey: unknown; SessionDynamicToolMetadataKey: unknown };
const { dispatchDynamicToolEvent, replayDynamicSessionTools } = lifecycle;
const { SessionIdKey, SessionDynamicToolMetadataKey } = keys;

ok(!("hydrateDynamicSessionTools" in lifecycle), "eve no longer exports hydrateDynamicSessionTools — the durable descriptor replaced it");
ok(
  typeof lifecycle.refreshDynamicSessionToolsForRuntimeRevision === "function",
  "…and refreshDynamicSessionToolsForRuntimeRevision is the replacement heal — it re-runs the session.started resolvers",
);

const REG_SYMBOL = Symbol.for("eve:dynamic-tool-callbacks");
const registry = (): Map<string, Map<string, unknown>> => (globalThis as Record<symbol, unknown>)[REG_SYMBOL] as Map<string, Map<string, unknown>>;

function described<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const live = (...a: A): R => fn(...a);
  return durable.stampDurableDynamicCallback(live as (...a: never[]) => unknown, {
    callback: ((_closure: Record<string, unknown>, ...a: unknown[]) => fn(...(a as A))) as ReplayFn,
    closure: {},
  }) as unknown as (...a: A) => R;
}

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
  readonly callbacks: Record<string, { readonly closure: Record<string, unknown> } | undefined>;
}

const TOOL = "synthetic_probe_tool";

console.log("1. execute-only synthetic tool (durable descriptor contract):");
{
  let callCount = 0;
  const execute = described(async () => {
    callCount++;
    return { ok: true, callCount };
  });
  const entry = defineTool({ description: "synthetic probe tool", inputSchema: { type: "object", properties: {} }, execute });

  const resolverDescriptor = { slug: TOOL, eventNames: ["session.started"], events: { "session.started": async () => entry } };
  const event = { type: "session.started" };

  const ctx = makeCtx("sess-ope867-native-heal-1");
  await dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  const metadata = ctx.get(SessionDynamicToolMetadataKey) as DurableRow[];
  ok(Array.isArray(metadata) && metadata.length === 1, "session.started resolve stored ONE durable metadata row");
  const row = metadata[0]!;
  eq(row.callbacks.execute, { closure: {} }, "the PERSISTED row carries only the closure — identity travels as (toolName, phase), not in the row");
  ok(!("stepId" in (row.callbacks.execute as object)), "…and it carries NO stepId — that key is the refused pre-release shape");
  ok(typeof durable.lookupDurableDynamicCallback(TOOL, "execute") === "function", "warm path: resolve REGISTERED the live callback under (toolName, phase)");

  const ctx2 = makeCtx("sess-ope867-native-heal-1-other");
  await dispatchDynamicToolEvent({ ctx: ctx2, resolvers: [resolverDescriptor], event, messages: [] });
  const row2 = (ctx2.get(SessionDynamicToolMetadataKey) as DurableRow[])[0]!;
  eq(row2.name, row.name, "a DIFFERENT session resolves the SAME tool name — the binding names code, never a session");
  eq(row2.callbacks.execute, row.callbacks.execute, "…and the same persisted descriptor, so replay in either session finds the same binding");

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

  const stale = defineTool({ description: "stale-shape probe", inputSchema: { type: "object", properties: {} }, execute: async () => ({ ok: true }) });
  Object.defineProperty(stale, Symbol.for("eve:durable-dynamic-tool-callbacks"), {
    configurable: true,
    value: { execute: { stepId: "eve:framework-dynamic:stale_probe_tool:_single", closure: {} } },
  });
  const ctxStale = makeCtx("sess-ope867-native-heal-stale");
  await dispatchDynamicToolEvent({
    ctx: ctxStale,
    resolvers: [{ slug: "stale_probe_tool", eventNames: ["session.started"], events: { "session.started": async () => stale } }],
    event,
    messages: [],
  });
  eq(
    (ctxStale.get(SessionDynamicToolMetadataKey) as DurableRow[]).length,
    0,
    "NEGATIVE CONTROL: a `{stepId, closure}` descriptor is REFUSED — the pre-release shape unmounts the tool rather than degrading",
  );

  (globalThis as Record<symbol, unknown>)[REG_SYMBOL] = new Map();
  ok(registry().size === 0, "registry wiped (cold-start simulation)");
  const cold = replayDynamicSessionTools([row], []);
  eq(cold.length, 1, "RED: a cold-resumed replay still MOUNTS the tool (eve does not drop it silently)");
  ok(durable.lookupDurableDynamicCallback(TOOL, "execute") === undefined, "RED: …and its binding is genuinely absent — the tool would throw if called");
  ok(
    durable.hasUnregisteredDurableDynamicCallbacks([{ callbacks: row.callbacks as Record<string, unknown>, name: row.name }]),
    "RED: …and eve's own detector reports it, which is what triggers the resolver re-run on resume",
  );

  const ctxWarm = makeCtx("sess-ope867-native-heal-1-resumed");
  await dispatchDynamicToolEvent({ ctx: ctxWarm, resolvers: [resolverDescriptor], event, messages: [] });
  ok(typeof durable.lookupDurableDynamicCallback(TOOL, "execute") === "function", "GREEN: re-resolving rebinds the SAME (toolName, phase) after a simulated cold start");
  ok(
    !durable.hasUnregisteredDurableDynamicCallbacks([{ callbacks: row.callbacks as Record<string, unknown>, name: row.name }]),
    "…and eve's detector agrees the row is bound again",
  );
  const replayed = replayDynamicSessionTools([row], []);
  eq(replayed.length === 1 && replayed[0]!.name, TOOL, "post-heal replay returns the tool under its mounted name");

  const bound = durable.lookupDurableDynamicCallback(TOOL, "execute")!;
  const result = (await bound(row.callbacks.execute!.closure, {}, {})) as { ok: boolean; callCount: number };
  eq(result, { ok: true, callCount: 1 }, "the restored binding IS the real closure (its own counter moved), not a mismatched tool");
}

console.log("2. approval-bearing synthetic tool (OPE-575 response-half):");
{
  const APPROVAL_TOOL = "synthetic_probe_approval_tool";
  const entry = defineTool({
    description: "synthetic approval probe",
    inputSchema: { type: "object", properties: {} },
    execute: described(async () => ({ ok: true })),
    approval: {
      request: described(async () => "user-approval"),
      response: described(async () => ({ status: "approved", reason: "probe" })),
    },
  });
  const resolverDescriptor = { slug: APPROVAL_TOOL, eventNames: ["session.started"], events: { "session.started": async () => entry } };
  const ctx = makeCtx("sess-ope867-native-heal-2");
  const event = { type: "session.started" };
  await dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
  const row = (ctx.get(SessionDynamicToolMetadataKey) as DurableRow[])[0]!;
  ok(row.callbacks.approvalRequest !== undefined, "the approval REQUEST phase carries its own durable descriptor");
  ok(row.callbacks.approvalResponse !== undefined, "…and so does the approval RESPONSE phase (the OPE-575 half)");
  ok(typeof durable.lookupDurableDynamicCallback(APPROVAL_TOOL, "approvalResponse") === "function", "…and resolve bound the response phase under its own (toolName, phase)");

  type ApprovalPair = { request(a: unknown): Promise<unknown>; response(a: unknown): Promise<{ status: string; reason?: string }> };
  const healthy = replayDynamicSessionTools([row], [])[0]!.approval as ApprovalPair;
  eq(await healthy.request({}), "user-approval", "replay serves the REAL approval request policy");
  eq(await healthy.response({}), { status: "approved", reason: "probe" }, "replay serves the REAL approval response authorizer");

  registry().get(APPROVAL_TOOL)!.delete("approvalResponse");
  const degraded = replayDynamicSessionTools([row], [])[0]!.approval as ApprovalPair;
  const verdict = await degraded.response({});
  eq(verdict.status, "rejected", "RED: a MISSING approval-response binding degrades to reject-everything (OPE-575's hazard, stated by eve itself)");
  ok(String(verdict.reason).includes(APPROVAL_TOOL), "…and the refusal names the tool whose binding went missing, so the cause is countable");
  ok(String(verdict.reason).includes("approvalResponse"), "…and the phase, so the cause is not merely the tool");

  const ctxAgain = makeCtx("sess-ope867-native-heal-2-resumed");
  await dispatchDynamicToolEvent({ ctx: ctxAgain, resolvers: [resolverDescriptor], event, messages: [] });
  const restored = replayDynamicSessionTools([row], [])[0]!.approval as ApprovalPair;
  eq(await restored.response({}), { status: "approved", reason: "probe" }, "GREEN: re-resolving restores the real authorizer");
}

console.log("3. a build-transform descriptor whose capture cannot serialize (OPE-1063):");
{
  const { preRegisterDynamicEntry } = await import("../agent/access/window-gated.js");
  const BROKEN = "synthetic_probe_unserializable_tool";
  const capturedEntry = { description: "the captured vendor entry", execute: async () => ({ ok: true }) };
  let callCount = 0;
  const live = async (): Promise<{ ok: boolean; callCount: number }> => {
    callCount++;
    return { ok: true, callCount };
  };
  const stamped = durable.stampDurableDynamicCallback(live as unknown as (...a: never[]) => unknown, {
    callback: ((_closure: Record<string, unknown>) => live()) as ReplayFn,
    closure: { entry: capturedEntry },
  }) as unknown as typeof live;
  const entry = defineTool({ description: "unserializable-capture probe", inputSchema: { type: "object", properties: {} }, execute: stamped });
  const resolverDescriptor = { slug: BROKEN, eventNames: ["session.started"], events: { "session.started": async () => entry } };
  const event = { type: "session.started" };

  const ctxBad = makeCtx("sess-ope1063-unserializable");
  await dispatchDynamicToolEvent({ ctx: ctxBad, resolvers: [resolverDescriptor], event, messages: [] });
  eq(
    (ctxBad.get(SessionDynamicToolMetadataKey) as DurableRow[]).length,
    0,
    "THE OPE-1063 DEFECT: a transform descriptor holding a non-serializable capture stores NO durable row — eve drops the tool silently",
  );
  ok(durable.lookupDurableDynamicCallback(BROKEN, "execute") === undefined, "…and nothing is bound, so the tool is absent from the seat rather than broken at call time");

  preRegisterDynamicEntry(BROKEN, "_single", entry as unknown as Parameters<typeof preRegisterDynamicEntry>[2]);
  const ctxHealed = makeCtx("sess-ope1063-unserializable-healed");
  await dispatchDynamicToolEvent({ ctx: ctxHealed, resolvers: [resolverDescriptor], event, messages: [] });
  const healedRows = ctxHealed.get(SessionDynamicToolMetadataKey) as DurableRow[];
  eq(healedRows.length, 1, "GREEN: after preRegisterDynamicEntry the SAME entry resolves and stores its durable row");
  eq(healedRows[0]!.callbacks.execute, { closure: {} }, "…and the persisted closure is EMPTY — the unserializable capture is gone from the metadata");

  const bound = durable.lookupDurableDynamicCallback(BROKEN, "execute")!;
  const result = (await bound(healedRows[0]!.callbacks.execute!.closure, {}, {})) as { ok: boolean; callCount: number };
  eq(result, { ok: true, callCount: 1 }, "…and the restored binding IS the real callback — the backstop keeps the behaviour, it only drops the capture");

  const SERIALIZABLE = "synthetic_probe_serializable_capture_tool";
  const liveOk = async (): Promise<{ ok: boolean }> => ({ ok: true });
  const stampedOk = durable.stampDurableDynamicCallback(liveOk as unknown as (...a: never[]) => unknown, {
    callback: ((_closure: Record<string, unknown>) => liveOk()) as ReplayFn,
    closure: { grantId: "g-1", limit: 3 },
  }) as unknown as typeof liveOk;
  const entryOk = defineTool({ description: "serializable-capture probe", inputSchema: { type: "object", properties: {} }, execute: stampedOk });
  preRegisterDynamicEntry(SERIALIZABLE, "_single", entryOk as unknown as Parameters<typeof preRegisterDynamicEntry>[2]);
  const ctxOk = makeCtx("sess-ope1063-serializable");
  await dispatchDynamicToolEvent({ ctx: ctxOk, resolvers: [{ slug: SERIALIZABLE, eventNames: ["session.started"], events: { "session.started": async () => entryOk } }], event, messages: [] });
  eq(
    (ctxOk.get(SessionDynamicToolMetadataKey) as DurableRow[])[0]!.callbacks.execute,
    { closure: { grantId: "g-1", limit: 3 } },
    "NEGATIVE CONTROL: a SERIALIZABLE capture is left alone — preRegisterDynamicEntry still defers to the transform there",
  );
}

console.log(`\ndynamic-tool-native-heal: ${n} assertions passed.`);
