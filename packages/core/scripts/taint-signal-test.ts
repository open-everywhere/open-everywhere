import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { beginTaintTurn, markUntrustedIngestedThisTurn, untrustedIngestedThisTurn, taintKindsThisTurn } from "../agent/access/taint-signal.js";
import { openTaintTurn } from "../agent/hooks/taint-turn.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../agent/identity/non-member.js";

const TAINT_SEED_ATTRS: readonly string[] = [OE_CHAT_NONMEMBER_ATTR];
import { renderChainResolution, resolveApproverChain, type ApprovalChainRequest } from "../agent/access/approver-chain.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("taint-signal");

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
  for (const attr of ["oe_spawn_tainted", "oe_tainted_fire", "oe_job_tainted"]) {
    boundary(`turn-retired-${attr}`, { [attr]: "true" });
    ok(untrustedIngestedThisTurn() === false, `🔴 OPE-2720: a wake carrying the retired \`${attr}\` stamp opens a CLEAN turn — the attribute is ignored`);
  }
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

await inSession(async () => {
  boundary("turn-kinds");
  ok(taintKindsThisTurn().length === 0, "kinds: a clean turn has no breakdown");
  markUntrustedIngestedThisTurn("web");
  markUntrustedIngestedThisTurn("github");
  markUntrustedIngestedThisTurn("web");
  ok(JSON.stringify(taintKindsThisTurn()) === JSON.stringify(["web", "github"]), "kinds: recorded first-seen and DEDUPED — this is what a card's disclosure line names");

  boundary("turn-kinds-next");
  ok(untrustedIngestedThisTurn() === false && taintKindsThisTurn().length === 0, "kinds: cleared at the turn boundary along with the flag");

  markUntrustedIngestedThisTurn();
  ok(untrustedIngestedThisTurn() === true && taintKindsThisTurn().length === 0, "kinds: a kindless mark taints with an EMPTY breakdown — empty ≠ clean");
});

{
  const trace = async (req: ApprovalChainRequest): Promise<string> => {
    const res = await resolveApproverChain(req);
    return renderChainResolution(req, res).find((l) => l.startsWith("context: ")) ?? "";
  };
  const base = { tool: "add_routine_rule", unattended: false, principalId: "U1" } as const;
  const shapes: { name: string; mark?: "web" | "linear"; supplied?: boolean }[] = [
    { name: "live", mark: "web" },
    { name: "supplied-true over clean", supplied: true },
    { name: "supplied-false over tainted", mark: "linear", supplied: false },
    { name: "supplied-true over tainted", mark: "web", supplied: true },
  ];
  for (const shape of shapes) {
    await inSession(async () => {
      boundary(`turn-render-${shape.name}`);
      if (shape.mark !== undefined) markUntrustedIngestedThisTurn(shape.mark);
      ok(untrustedIngestedThisTurn() === (shape.mark !== undefined), `render/${shape.name}: precondition — the live signal is as set`);
      const line = await trace(shape.supplied === undefined ? { ...base } : { ...base, tainted: shape.supplied });
      ok(line.startsWith("context: unattended: false"), `render/${shape.name}: the context line is still rendered`);
      ok(!/taint/i.test(line), `render/${shape.name}: …and it carries no taint (OPE-2716)`);
    });
  }
}

console.log(`✓ taint-signal: ${n} assertions passed`);
