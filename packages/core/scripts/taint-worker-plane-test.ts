import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { markUntrustedIngestedThisTurn, untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { nativeAgentAllowedNow, setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { openTaintTurn, seedIfTainted, OE_PARENT_TURN_TAINTED_ATTR } from "../agent/hooks/spawn-taint.js";
import { OE_SPAWN_TAINTED_ATTR } from "../agent/channels/unified.js";
import { resetSettingsForTest } from "../agent/settings/settings.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("taint-worker-plane");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

class FakeSession {
  private readonly store = new Map<string, unknown>();
  constructor(readonly id = "sess-worker-plane") {}
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

async function inSession<T>(fn: (s: FakeSession) => T | Promise<T>, session = new FakeSession()): Promise<T> {
  return eveContextStorage().run(session, () => fn(session));
}

resetSettingsForTest();

console.log("5 — a native child of a tainted parent turn is MARKED:");
{
  await inSession(() => {
    const ctx = { session: { auth: { current: { attributes: { [OE_SPAWN_TAINTED_ATTR]: "true" } } } } };
    seedIfTainted(ctx as never);
    eq(untrustedIngestedThisTurn(), true, "[5] POSITIVE CONTROL: the `oe_spawn_tainted` seed consumer WORKS — a stamped opening auth taints the child's turn");
  });

  const parentBag: Record<string, unknown> = { oe_window_grain: "standing" };
  await inSession(() => {
    const parent = { session: { id: "wplane-parent", turn: { id: "turn_4", sequence: 4 }, auth: { current: { attributes: parentBag } } } };
    openTaintTurn(parent as never);
    markUntrustedIngestedThisTurn("web");
    ok(untrustedIngestedThisTurn(), "[5] precondition: the PARENT turn is tainted");
    eq(
      parentBag[OE_PARENT_TURN_TAINTED_ATTR],
      "wplane-parent|turn_4|web",
      "[5] 🔴 THE STAMP: the tainted parent turn wrote its own (session, turn) pair into the auth bag eve copies — with the KIND it read (OPE-1215), so the child can name the source in any bullet it writes",
    );
  });
  await inSession(() => {
    const child = {
      session: {
        id: "wplane-child",
        turn: { id: "turn_0", sequence: 0 },
        parent: { sessionId: "wplane-parent", callId: "call_w1", turn: { id: "turn_4", sequence: 4 } },
        auth: { current: { attributes: { ...parentBag } } },
      },
    };
    openTaintTurn(child as never);
    eq(
      untrustedIngestedThisTurn(),
      true,
      "[5] 🔴 THE CARRIAGE, MEASURED: a native child of a TAINTED parent turn starts MARKED",
    );
  });

  await inSession(() => {
    const cleanBag: Record<string, unknown> = { oe_window_grain: "standing" };
    const child = {
      session: {
        id: "wplane-child-clean",
        turn: { id: "turn_0", sequence: 0 },
        parent: { sessionId: "wplane-parent-clean", callId: "call_w2", turn: { id: "turn_4", sequence: 4 } },
        auth: { current: { attributes: cleanBag } },
      },
    };
    openTaintTurn(child as never);
    eq(untrustedIngestedThisTurn(), false, "[5] 🔴 NEGATIVE CONTROL: a child of a CLEAN parent turn starts clean — asserted `=== false`, not merely falsy");
  });

  await inSession(() => {
    setNativeDelegationSeat("allow");
    eq(nativeAgentAllowedNow(), true, "[5] precondition: a positively-classified delegating seat holds the built-in `agent` on a CLEAN turn");
    markUntrustedIngestedThisTurn("web");
    eq(
      nativeAgentAllowedNow(),
      true,
      "[5] 🔴 THE WITHDRAWAL IS LIFTED (OPE-471): a tainted turn KEEPS `agent`, because the child it dispatches is marked. The launder path is closed by PROPAGATION, not by absence",
    );
  });

  await inSession(() => {
    setNativeDelegationSeat("unclassified");
    markUntrustedIngestedThisTurn("web");
    eq(nativeAgentAllowedNow(), false, "[5] 🔴 NEGATIVE CONTROL: an unclassified seat is still refused `agent` on the same tainted turn");
  });
}

console.log(`\ntaint-worker-plane: ${n} assertions passed`);
