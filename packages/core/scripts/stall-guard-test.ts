import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolContext, ToolDefinition } from "eve/tools";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import {
  DEFAULT_STALL_THRESHOLD,
  RESULT_HASH_CAP_BYTES,
  stallThreshold,
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
import { pinSuiteStore } from "./_suite-store.js";

pinSuiteStore("stall-guard");

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
async function simulateCall(
  wrapped: ToolDefinition,
  turnId: string,
  toolName: string,
  input: unknown,
  output: unknown,
): Promise<{ tripped: boolean; message?: string }> {
  const callId = `call-${callSeq++}`;
  recordActionRequest(turnId, callId, toolName, input);
  try {
    await wrapped.execute(input, fakeCtx);
  } catch (err) {
    return { tripped: true, message: (err as Error).message };
  }
  recordActionResult(turnId, callId, toolName, output);
  return { tripped: false };
}

{
  overrideSettingsForTest({ stall: { repeatThreshold: 3 } });
  ok(stallThreshold() === DEFAULT_STALL_THRESHOLD && DEFAULT_STALL_THRESHOLD === 3, "config: default threshold is 3");
  overrideSettingsForTest({ stall: { repeatThreshold: 5 } });
  ok(stallThreshold() === 5, "config: OE_STALL_REPEAT_THRESHOLD overrides the default");
  overrideSettingsForTest({ stall: { repeatThreshold: 0 } });
  ok(stallThreshold() === 0, "config: 0 disables");
  overrideSettingsForTest({ stall: { repeatThreshold: 3 } });
  process.env.OE_STALL_REPEAT_THRESHOLD = "0";
  ok(stallThreshold() === DEFAULT_STALL_THRESHOLD, "config: a stray OE_STALL_REPEAT_THRESHOLD=0 does NOT disable the guard — the mirror is deleted (OPE-411)");
  delete process.env.OE_STALL_REPEAT_THRESHOLD;
}

{
  const args = inputKeyOf({ cmd: "vercel inspect" });
  ok(signatureOf("bash", args, "pending") !== signatureOf("bash", args, "READY"), "signature: same tool+args, different result -> different signature");
  ok(signatureOf("bash", args, "x") === signatureOf("bash", args, "x"), "signature: identical (tool,args,result) -> stable signature");
  ok(signatureOf("bash", inputKeyOf({ a: 1, b: 2 }), "x") === signatureOf("bash", inputKeyOf({ b: 2, a: 1 }), "x"), "signature: arg key order is normalised away");
  ok(isGuardedTool("bash") && !isGuardedTool("reply") && !isGuardedTool("agent"), "allow-list: bash guarded; reply/agent not");

  const base = "a".repeat(RESULT_HASH_CAP_BYTES * 2);
  const beyond = `${base.slice(0, RESULT_HASH_CAP_BYTES * 2 - 5)}bbbbb`;
  const within = `a${"c"}${"a".repeat(RESULT_HASH_CAP_BYTES * 2)}`;
  ok(signatureOf("bash", args, base) === signatureOf("bash", args, beyond), "cap: differences BEYOND the cap don't change the signature");
  ok(signatureOf("bash", args, base) !== signatureOf("bash", args, within), "cap: differences WITHIN the cap still change the signature");
}

await inSession(async () => {
  const N = stallThreshold();
  const wrapped = withStallGuard("bash", fakeTool());
  const identical = { cmd: "vercel inspect deploy-123" };

  const results: { tripped: boolean; message?: string }[] = [];
  for (let i = 0; i < N + 1; i++) results.push(await simulateCall(wrapped, "t1", "bash", identical, "still building..."));

  ok(results.slice(0, N).every((r) => !r.tripped), `first ${N} identical calls execute (no trip)`);
  ok(results[N].tripped, `the ${N + 1}th identical call is nudged`);
  ok(results[N].message === stallNudge("bash", 1), "the nudge carries the guard's strike-1 message");
  ok(/isn't making progress/.test(results[N].message ?? ""), "nudge tells the model to stop repeating");

  const afterTrip = await simulateCall(wrapped, "t1", "bash", identical, "still building...");
  ok(!afterTrip.tripped, "after firing, the very next identical call is NOT nudged (counter reset)");
});

await inSession(async () => {
  const N = stallThreshold();
  const wrapped = withStallGuard("bash", fakeTool());
  const identical = { cmd: "vercel inspect deploy-123" };
  let tripped = false;
  for (let i = 0; i < N * 3; i++) {
    const r = await simulateCall(wrapped, "t1", "bash", identical, `progress-${i}`);
    tripped ||= r.tripped;
  }
  ok(!tripped, "polling: identical args with a changing result never trips");
});

await inSession(async () => {
  const N = stallThreshold();
  const wrapped = withStallGuard("react", fakeTool());
  ok(wrapped === undefined ? false : true, "allow-listed wrap returns a tool");
  let tripped = false;
  for (let i = 0; i < N * 2; i++) {
    const r = await simulateCall(wrapped, "t1", "react", { emoji: "eyes" }, { ok: true });
    tripped ||= r.tripped;
  }
  ok(!tripped, "allow-listed react: identical calls never trip");
});

await inSession(async () => {
  const N = stallThreshold();
  const wrapped = withStallGuard("bash", fakeTool());
  const identical = { cmd: "still stuck" };
  const nudges: string[] = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < N + 1; i++) {
      const r = await simulateCall(wrapped, "t1", "bash", identical, "no change");
      if (r.tripped && r.message) nudges.push(r.message);
    }
  }
  ok(nudges.length === 3, "escalation: a persistent loop trips once per re-arm");
  ok(nudges[0] === stallNudge("bash", 1) && /isn't making progress/.test(nudges[0]), "escalation: first nudge is strike-1 wording");
  ok(nudges[1] === stallNudge("bash", 2) && nudges[1] !== nudges[0] && /STILL looping/.test(nudges[1]), "escalation: second nudge escalates");
  ok(nudges[2] === stallNudge("bash", 3) && /stuck in a loop/.test(nudges[2]), "escalation: third nudge is the strongest");
});

await inSession(async () => {
  const N = stallThreshold();
  const wrapped = withStallGuard("bash", fakeTool());
  const identical = { cmd: "carry?" };
  for (let i = 0; i < N; i++) await simulateCall(wrapped, "t1", "bash", identical, "same");
  const first = await simulateCall(wrapped, "t2", "bash", identical, "same");
  ok(!first.tripped, "turn reset: the armed counter does not carry into a new turn");
  const rearm: { tripped: boolean }[] = [];
  for (let i = 0; i < N; i++) rearm.push(await simulateCall(wrapped, "t2", "bash", identical, "same"));
  ok(rearm[N - 1].tripped, "turn reset: a fresh run of N identical calls trips within the new turn");
});

await inSession(async () => {
  overrideSettingsForTest({ stall: { repeatThreshold: 0 } });
  const wrapped = withStallGuard("bash", fakeTool());
  let tripped = false;
  for (let i = 0; i < 10; i++) {
    const r = await simulateCall(wrapped, "t1", "bash", { cmd: "disabled" }, "same");
    tripped ||= r.tripped;
  }
  ok(!tripped, "disabled: identical calls never trip when the threshold is 0");
  overrideSettingsForTest({ stall: { repeatThreshold: 3 } });
});

await inSession(async () => {
  const N = stallThreshold();
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
  for (let i = 0; i < N + 1; i++) await simulateCall(wrapped, "t1", "bash", identical, "still building...");
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
