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
  refreshDynamicSessionToolsForRuntimeRevision?(i: unknown): Promise<void>;
};
const { replayDynamicTools } = (await import(u("context/build-dynamic-tools.js"))) as {
  replayDynamicTools(meta: readonly unknown[], scope: { sessionId: string; scope: string }): { name: string; approval?: unknown }[];
};
type ReplayFn = (closure: Record<string, unknown>, ...a: unknown[]) => unknown;
const durable = (await import(u("tools/durable-callbacks.js"))) as {
  stampDurableDynamicCallback<T extends (...a: never[]) => unknown>(cb: T, d: { callback: ReplayFn; closure: Record<string, unknown> }): T;
  lookupDurableDynamicCallback(owner: Record<string, unknown>, phase: string): ReplayFn | undefined;
  hasUnregisteredDurableDynamicCallbacks(meta: readonly { callbacks: Record<string, unknown>; name: string }[], scope: Record<string, unknown>): boolean;
};
const keys = (await import(u("context/keys.js"))) as { SessionIdKey: unknown; StaticModelReferenceKey: unknown; SessionDynamicToolMetadataKey: unknown };
const { dispatchDynamicToolEvent } = lifecycle;

const ownerOf = (row: { name: string }, sessionId: string): Record<string, unknown> => ({ ...row, sessionId, scope: "session" });
const { SessionIdKey, StaticModelReferenceKey, SessionDynamicToolMetadataKey } = keys;

ok(!("hydrateDynamicSessionTools" in lifecycle), "eve no longer exports hydrateDynamicSessionTools — the durable descriptor replaced it");
ok(
  typeof lifecycle.refreshDynamicSessionToolsForRuntimeRevision === "function",
  "…and refreshDynamicSessionToolsForRuntimeRevision is the replacement heal — it re-runs the session.started resolvers",
);

const REG_SYMBOL = Symbol.for("eve:scoped-dynamic-tool-callbacks");
const registry = (): Map<string, Map<string, unknown>> => (globalThis as Record<symbol, unknown>)[REG_SYMBOL] as Map<string, Map<string, unknown>>;
const keyOf = (row: Record<string, unknown>, phase: string): string =>
  JSON.stringify(["session", row.resolverSlug, row.entryKey, row.name, phase]);

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
  store.set(StaticModelReferenceKey, null);
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
  ok(
    typeof durable.lookupDurableDynamicCallback(ownerOf(row, "sess-ope867-native-heal-1"), "execute") === "function",
    "warm path: resolve REGISTERED the live callback under the row's OWNER SCOPE",
  );

  const ctx2 = makeCtx("sess-ope867-native-heal-1-other");
  await dispatchDynamicToolEvent({ ctx: ctx2, resolvers: [resolverDescriptor], event, messages: [] });
  const row2 = (ctx2.get(SessionDynamicToolMetadataKey) as DurableRow[])[0]!;
  eq(row2.name, row.name, "a DIFFERENT session resolves the SAME tool name — the binding names code, never a session");
  eq(row2.callbacks.execute, row.callbacks.execute, "…and the same persisted descriptor, so a re-resolve in any session rebuilds the same row");
  ok(
    durable.lookupDurableDynamicCallback(ownerOf(row, "sess-ope867-native-heal-1-other"), "execute") !== undefined,
    "the SECOND session registered its own binding for the same code (it resolved in that session too)",
  );
  ok(
    durable.lookupDurableDynamicCallback(ownerOf(row, "sess-never-resolved-here"), "execute") === undefined,
    "🔴 …and a session that never resolved has NO binding — the registry is bucketed by session id since eve 0.54.x, so identity no longer crosses sessions",
  );

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
  const cold = replayDynamicTools([row], { sessionId: "sess-ope867-native-heal-1", scope: "session" });
  eq(cold.length, 1, "RED: a cold-resumed replay still MOUNTS the tool (eve does not drop it silently)");
  ok(
    durable.lookupDurableDynamicCallback(ownerOf(row, "sess-ope867-native-heal-1"), "execute") === undefined,
    "RED: …and its binding is genuinely absent — the tool would throw if called",
  );
  ok(
    durable.hasUnregisteredDurableDynamicCallbacks([row as unknown as { callbacks: Record<string, unknown>; name: string }], { sessionId: "sess-ope867-native-heal-1", scope: "session" }),
    "RED: …and eve's own detector reports it, which is what triggers the resolver re-run on resume",
  );

  const ctxWarm = makeCtx("sess-ope867-native-heal-1-resumed");
  await dispatchDynamicToolEvent({ ctx: ctxWarm, resolvers: [resolverDescriptor], event, messages: [] });
  ok(
    typeof durable.lookupDurableDynamicCallback(ownerOf(row, "sess-ope867-native-heal-1-resumed"), "execute") === "function",
    "GREEN: re-resolving rebinds the row's owner scope after a simulated cold start",
  );
  ok(
    !durable.hasUnregisteredDurableDynamicCallbacks([row as unknown as { callbacks: Record<string, unknown>; name: string }], { sessionId: "sess-ope867-native-heal-1-resumed", scope: "session" }),
    "…and eve's detector agrees the row is bound again",
  );
  const replayed = replayDynamicTools([row], { sessionId: "sess-ope867-native-heal-1-resumed", scope: "session" });
  eq(replayed.length === 1 && replayed[0]!.name, TOOL, "post-heal replay returns the tool under its mounted name");

  const bound = durable.lookupDurableDynamicCallback(ownerOf(row, "sess-ope867-native-heal-1-resumed"), "execute")!;
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
  ok(typeof durable.lookupDurableDynamicCallback(ownerOf(row, "sess-ope867-native-heal-2"), "approvalResponse") === "function", "…and resolve bound the response phase under its own (toolName, phase)");

  type ApprovalPair = { request(a: unknown): Promise<unknown>; response(a: unknown): Promise<{ status: string; reason?: string }> };
  const healthy = replayDynamicTools([row], { sessionId: "sess-ope867-native-heal-2", scope: "session" })[0]!.approval as ApprovalPair;
  eq(await healthy.request({}), "user-approval", "replay serves the REAL approval request policy");
  eq(await healthy.response({}), { status: "approved", reason: "probe" }, "replay serves the REAL approval response authorizer");

  registry().get("sess-ope867-native-heal-2")!.delete(keyOf(row as unknown as Record<string, unknown>, "approvalResponse"));
  const degraded = replayDynamicTools([row], { sessionId: "sess-ope867-native-heal-2", scope: "session" })[0]!.approval as ApprovalPair;
  const verdict = await degraded.response({});
  eq(verdict.status, "rejected", "RED: a MISSING approval-response binding degrades to reject-everything (OPE-575's hazard, stated by eve itself)");
  ok(String(verdict.reason).includes(APPROVAL_TOOL), "…and the refusal names the tool whose binding went missing, so the cause is countable");
  ok(String(verdict.reason).includes("approvalResponse"), "…and the phase, so the cause is not merely the tool");

  const ctxAgain = makeCtx("sess-ope867-native-heal-2-resumed");
  await dispatchDynamicToolEvent({ ctx: ctxAgain, resolvers: [resolverDescriptor], event, messages: [] });
  const restored = replayDynamicTools([row], { sessionId: "sess-ope867-native-heal-2-resumed", scope: "session" })[0]!.approval as ApprovalPair;
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
  ok(
    durable.lookupDurableDynamicCallback({ name: BROKEN, resolverSlug: BROKEN, entryKey: "_single", sessionId: "sess-ope1063-unserializable", scope: "session" }, "execute") === undefined,
    "…and nothing is bound, so the tool is absent from the seat rather than broken at call time",
  );

  preRegisterDynamicEntry(BROKEN, "_single", entry as unknown as Parameters<typeof preRegisterDynamicEntry>[2]);
  const ctxHealed = makeCtx("sess-ope1063-unserializable-healed");
  await dispatchDynamicToolEvent({ ctx: ctxHealed, resolvers: [resolverDescriptor], event, messages: [] });
  const healedRows = ctxHealed.get(SessionDynamicToolMetadataKey) as DurableRow[];
  eq(healedRows.length, 1, "GREEN: after preRegisterDynamicEntry the SAME entry resolves and stores its durable row");
  eq(healedRows[0]!.callbacks.execute, { closure: {} }, "…and the persisted closure is EMPTY — the unserializable capture is gone from the metadata");

  const bound = durable.lookupDurableDynamicCallback(ownerOf(healedRows[0]!, "sess-ope1063-unserializable-healed"), "execute")!;
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

console.log("4. variant-dispatched toModelOutput across ONE mounted name (OPE-1068):");
{
  const { preRegisterDynamicVariants } = await import("../agent/access/window-gated.js");
  const { registeredProjectionNames } = await import("../agent/access/untrusted-projection.js");
  const NAME = "synthetic_probe_variant_projection_tool";

  interface ProbeEntry {
    description: string;
    inputSchema: Record<string, unknown>;
    execute(): Promise<{ marker: string; ok: boolean }>;
    toModelOutput?(output: unknown): { type: string; value: string };
  }
  const withProjection = (marker: string): ProbeEntry =>
    defineTool({
      description: `variant ${marker}`,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ marker, ok: true }),
      toModelOutput: (output: unknown) => ({ type: "text", value: `${marker}|${JSON.stringify(output)}` }),
    }) as unknown as ProbeEntry;
  const alpha = withProjection("alpha");
  const beta = withProjection("beta");
  const plain = defineTool({
    description: "variant plain",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ marker: "plain", ok: true }),
  }) as unknown as ProbeEntry;

  preRegisterDynamicVariants(NAME, { alpha, beta, plain });

  const event = { type: "session.started" };
  const resolveWith = async (entry: ProbeEntry, sessionId: string): Promise<DurableRow> => {
    const ctx = makeCtx(sessionId);
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [{ slug: NAME, eventNames: ["session.started"], events: { "session.started": async () => entry } }],
      event,
      messages: [],
    });
    const rows = ctx.get(SessionDynamicToolMetadataKey) as DurableRow[];
    return rows[0]!;
  };

  const rowAlpha = await resolveWith(alpha, "sess-ope1068-variant-alpha");
  const rowBeta = await resolveWith(beta, "sess-ope1068-variant-beta");
  ok(rowAlpha !== undefined && rowBeta !== undefined, "both projection-authoring variants resolve — eve accepts the descriptor OE fills for the toModelOutput phase");
  eq(rowAlpha.callbacks.toModelOutput, { closure: { entryKey: "alpha" } }, "alpha's PERSISTED row names its own variant in the toModelOutput closure");
  eq(rowBeta.callbacks.toModelOutput, { closure: { entryKey: "beta" } }, "…and beta's names beta — the closure is the only thing that tells them apart");
  ok(
    typeof durable.lookupDurableDynamicCallback(ownerOf(rowBeta, "sess-ope1068-variant-beta"), "toModelOutput") === "function",
    "resolve BOUND a toModelOutput callback under the resolving session's owner scope — since eve 0.54.x each session holds its own binding, so this asks beta's session for beta's row",
  );

  type Replayed = { name: string; toModelOutput?: (output: unknown) => { type: string; value: string } };
  const replayedAlpha = replayDynamicTools([rowAlpha], { sessionId: "sess-ope1068-variant-alpha", scope: "session" })[0]! as Replayed;
  const replayedBeta = replayDynamicTools([rowBeta], { sessionId: "sess-ope1068-variant-beta", scope: "session" })[0]! as Replayed;
  ok(typeof replayedAlpha.toModelOutput === "function", "eve REPLAYS the authored projection onto the rebuilt tool (the OPE-73 drop is closed at 0.44.0)");
  eq(replayedAlpha.toModelOutput!({ n: 1 }), { type: "text", value: 'alpha|{"n":1}' }, "alpha's replayed tool runs ALPHA's projection — the closure re-selected the variant the session mounted");
  eq(replayedBeta.toModelOutput!({ n: 1 }), { type: "text", value: 'beta|{"n":1}' }, "…and beta's runs BETA's, from the same shared callback — one name, two projections, no collision");

  const rowPlain = await resolveWith(plain, "sess-ope1068-variant-plain");
  ok(rowPlain.callbacks.toModelOutput === undefined, "NEGATIVE CONTROL: a variant with no authored projection persists NO toModelOutput phase");
  ok(rowPlain.callbacks.execute !== undefined, "…while still carrying its execute descriptor, so it mounts normally");
  ok(
    (replayDynamicTools([rowPlain], { sessionId: "sess-ope1068-variant-plain", scope: "session" })[0]! as Replayed).toModelOutput === undefined,
    "…and its replayed tool carries no projection — the raw output reaches eve's own default rendering",
  );

  ok(!registeredProjectionNames().includes(NAME), "NEGATIVE CONTROL: no variant name enters the projection registry — membership would vouch for every variant at once, and for a `__` name it would disable the connector fence");
}

console.log(`\ndynamic-tool-native-heal: ${n} assertions passed.`);
