import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolContext, ToolDefinition } from "eve/tools";
import {
  STALL_THRESHOLD,
  isGuardedTool,
  signatureOf,
  inputKeyOf,
  withStallGuard,
  recordActionRequest,
  recordActionResult,
  stallNudge,
} from "../agent/stall/guard.js";
import {
  emitTelemetry,
  flushTelemetry,
  __resetTelemetryForTest,
  __queueLengthForTest,
  __setInstanceForTest,
} from "../agent/observability/telemetry.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}

function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

async function inSession<T>(fn: () => T | Promise<T>): Promise<T> {
  return eveContextStorage().run(new FakeSession(), fn);
}

const fakeCtx = {} as ToolContext;
function fakeTool(): ToolDefinition {
  return { description: "fake", inputSchema: {}, outputSchema: {}, execute: async () => ({ ok: true }) } as unknown as ToolDefinition;
}

let callSeq = 0;
async function simulateCall(wrapped: ToolDefinition, toolName: string, input: unknown, output: unknown): Promise<{ tripped: boolean; message?: string }> {
  const callId = `call-${callSeq++}`;
  try {
    await wrapped.execute(input, fakeCtx);
  } catch (err) {
    return { tripped: true, message: (err as Error).message };
  }
  recordActionRequest(callId, toolName, input);
  recordActionResult(callId, toolName, output);
  return { tripped: false };
}

{
  const args = inputKeyOf({ cmd: "vercel inspect" });
  ok(signatureOf("bash", args, "pending") !== signatureOf("bash", args, "READY"), "signature: same tool+args, different result -> different signature");
  ok(signatureOf("bash", args, "x") === signatureOf("bash", args, "x"), "signature: identical (tool,args,result) -> stable signature");
  ok(signatureOf("bash", inputKeyOf({ a: 1, b: 2 }), "x") === signatureOf("bash", inputKeyOf({ b: 2, a: 1 }), "x"), "signature: arg key order is normalised away");
  ok(isGuardedTool("bash") && !isGuardedTool("reply") && !isGuardedTool("agent"), "allow-list: bash guarded; reply/agent not");
}

await inSession(async () => {
  const wrapped = withStallGuard("bash", fakeTool());
  const identical = { cmd: "vercel inspect deploy-123" };

  const results: { tripped: boolean; message?: string }[] = [];
  for (let i = 0; i < STALL_THRESHOLD + 1; i++) results.push(await simulateCall(wrapped, "bash", identical, "still building..."));

  ok(results.slice(0, STALL_THRESHOLD).every((r) => !r.tripped), `first ${STALL_THRESHOLD} identical calls execute (no trip)`);
  ok(results[STALL_THRESHOLD].tripped, `the ${STALL_THRESHOLD + 1}th identical call is nudged`);
  ok(results[STALL_THRESHOLD].message === stallNudge("bash"), "the nudge carries the guard's message");
  ok(/isn't making progress/.test(results[STALL_THRESHOLD].message ?? ""), "nudge tells the model to stop repeating");

  const afterTrip = await simulateCall(wrapped, "bash", identical, "still building...");
  ok(!afterTrip.tripped, "after firing, the very next identical call is NOT nudged (counter reset)");
  const rearm: { tripped: boolean }[] = [];
  for (let i = 0; i < STALL_THRESHOLD; i++) rearm.push(await simulateCall(wrapped, "bash", identical, "still building..."));
  ok(!rearm.slice(0, STALL_THRESHOLD - 1).some((r) => r.tripped), "re-arm: intermediate identical calls run");
  ok(rearm[STALL_THRESHOLD - 1].tripped, "re-arm: a fresh run of N identical calls trips again");
});

await inSession(async () => {
  const wrapped = withStallGuard("bash", fakeTool());
  const identical = { cmd: "vercel inspect deploy-123" };
  let tripped = false;
  for (let i = 0; i < STALL_THRESHOLD * 3; i++) {
    const r = await simulateCall(wrapped, "bash", identical, `progress-${i}`);
    tripped ||= r.tripped;
  }
  ok(!tripped, "polling: identical args with a changing result never trips");
});

await inSession(async () => {
  const wrapped = withStallGuard("react", fakeTool());
  ok(wrapped === undefined ? false : true, "allow-listed wrap returns a tool");
  let tripped = false;
  for (let i = 0; i < STALL_THRESHOLD * 2; i++) {
    const r = await simulateCall(wrapped, "react", { emoji: "eyes" }, { ok: true });
    tripped ||= r.tripped;
  }
  ok(!tripped, "allow-listed react: identical calls never trip");
});

await inSession(async () => {
  const calls: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  __resetTelemetryForTest({ fetchImpl });
  __setInstanceForTest({ id: "instance-stall", ephemeral: false });
  emitTelemetry("oe.feature.used", { "oe.feature": "probe", "oe.outcome": "ok" });
  ok(__queueLengthForTest() >= 1, "telemetry: emit queues in this env");
  __resetTelemetryForTest({ fetchImpl });
  __setInstanceForTest({ id: "instance-stall", ephemeral: false });

  const wrapped = withStallGuard("bash", fakeTool());
  const identical = { cmd: "vercel inspect deploy-123" };
  for (let i = 0; i < STALL_THRESHOLD + 1; i++) await simulateCall(wrapped, "bash", identical, "still building...");
  await flushTelemetry();

  const eventNames = calls.flatMap((body) => {
    const b = body as { resourceLogs?: { scopeLogs: { logRecords: { eventName: string; attributes?: { key: string; value: unknown }[] }[] }[] }[] };
    return (b.resourceLogs ?? []).flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords));
  });
  const trip = eventNames.find((r) => r.eventName === "oe.feature.used");
  ok(!!trip, "telemetry: a trip emits oe.feature.used");
  const featureAttr = (trip?.attributes ?? []).find((a) => a.key === "oe.feature");
  const featureVal = (featureAttr?.value as { stringValue?: string } | undefined)?.stringValue;
  ok(featureVal === "stall_guard", "telemetry: the trip is tagged oe.feature=stall_guard");
});

__resetTelemetryForTest();
console.log(`✓ stall-guard: ${n} assertions passed`);
