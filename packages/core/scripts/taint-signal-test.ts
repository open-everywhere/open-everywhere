import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { markUntrustedIngestedThisTurn, untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};


ok(untrustedIngestedThisTurn() === false, "no context: reader returns false");
markUntrustedIngestedThisTurn();
ok(untrustedIngestedThisTurn() === false, "no context: setter is a no-op, reader stays false");

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

console.log(`✓ taint-signal: ${n} assertions passed`);
