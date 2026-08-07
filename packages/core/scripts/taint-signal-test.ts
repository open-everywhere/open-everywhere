import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { beginTaintTurn, markUntrustedIngestedThisTurn, untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { openTaintTurn, TAINT_SEED_ATTRS } from "../agent/hooks/spawn-taint.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};


ok(untrustedIngestedThisTurn() === false, "no context: reader returns false");
markUntrustedIngestedThisTurn();
ok(untrustedIngestedThisTurn() === false, "no context: setter is a no-op, reader stays false");
beginTaintTurn("turn-x");
ok(untrustedIngestedThisTurn() === false, "no context: beginTaintTurn is a no-op and never throws");

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

await inSession(async () => {
  ok(untrustedIngestedThisTurn() === false, "in context: default is false");
  markUntrustedIngestedThisTurn();
  ok(untrustedIngestedThisTurn() === true, "in context: mark sets the flag");
  ok(untrustedIngestedThisTurn() === true, "in context: read does not consume the flag");
});

await inSession(async () => {
  ok(untrustedIngestedThisTurn() === false, "fresh session: flag does not bleed from the prior session");
});

const boundary = (turnId: string | undefined, attributes: Record<string, unknown> = {}) =>
  openTaintTurn({ session: { turn: { id: turnId }, auth: { current: { attributes } } } } as unknown as Parameters<typeof openTaintTurn>[0]);

await inSession(async () => {
  boundary("turn-1");
  ok(untrustedIngestedThisTurn() === false, "turn 1 opens clean");
  markUntrustedIngestedThisTurn();
  ok(untrustedIngestedThisTurn() === true, "turn 1: an ingestion taints it");
  markUntrustedIngestedThisTurn();
  ok(untrustedIngestedThisTurn() === true, "turn 1: still tainted after a second mark (monotonic within a turn)");

  boundary("turn-2");
  ok(untrustedIngestedThisTurn() === false, "turn 2 of the SAME session starts CLEAN — taint does not survive the turn boundary (the whole of OPE-299 §A)");

  for (const attr of TAINT_SEED_ATTRS) {
    boundary(`turn-seed-${attr}`, { [attr]: "true" });
    ok(untrustedIngestedThisTurn() === true, `a wake carrying \`${attr}\` taints the turn it opens (reset runs FIRST, then seeds)`);
    boundary(`turn-after-${attr}`);
    ok(untrustedIngestedThisTurn() === false, `…and the turn after \`${attr}\` is clean again (a stamp taints its OWN turn, not the session)`);
  }
  boundary("turn-array", { [TAINT_SEED_ATTRS[0]]: ["true"] });
  ok(untrustedIngestedThisTurn() === true, "a seed attribute in eve's `string[]` spelling taints the turn as well");
});

await inSession(async () => {
  boundary("turn-a");
  markUntrustedIngestedThisTurn();
  boundary("turn-a");
  ok(untrustedIngestedThisTurn() === true, "the SAME turn id seen twice does NOT re-clear — the reset is idempotent per turn, not unconditional");
  boundary(undefined);
  ok(untrustedIngestedThisTurn() === true, "an UNREADABLE turn id does NOT clear — unable to prove a new turn, the slot keeps the old, stricter behaviour");
  boundary("turn-b");
  ok(untrustedIngestedThisTurn() === false, "…and a readable, DIFFERENT turn id does clear (the three cases above are a rule, not a no-op)");
});

{
  const legacy = new FakeSession();
  legacy.set({ name: "open-everywhere.untrusted-ingested" }, true as unknown as { tainted: boolean });
  await eveContextStorage().run(legacy, async () => {
    ok(untrustedIngestedThisTurn() === true, "a LEGACY durable `true` (pre-OPE-299 boolean shape) still reads as tainted");
    boundary("turn-post-deploy");
    ok(untrustedIngestedThisTurn() === false, "…and clears at the first boundary that can prove a new turn");
  });
}

console.log(`✓ taint-signal: ${n} assertions passed`);
