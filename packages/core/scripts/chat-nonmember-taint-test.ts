import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  nonMemberChatTrust,
  chatWakeIngestsNonMember,
  nonMemberChatAttrs,
  stampNonMemberChatAuth,
  untrustedIngestedThisTurn,
  OE_CHAT_NONMEMBER_ATTR,
} from "../agent/access/taint-signal.js";
import { TAINT_SEED_ATTRS, openTaintTurn } from "../agent/hooks/spawn-taint.js";
import { classifyIngestion } from "../agent/access/taint-tiers.js";
import { decideIngestion } from "../agent/access/taint-enforcement.js";
import type { WakeTrust } from "../agent/channels/wake-envelope.js";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}
function eq<T>(actual: T, expected: T, msg: string): void {
  assert.deepStrictEqual(actual, expected, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

console.log("1. the join:");

ok(nonMemberChatTrust("unauth") === true, "🔴 `unauth` IS the non-member tier — a positively-human author the surface gate could not vouch as internal");
ok(nonMemberChatTrust("peer") === false, "negative control: a vouched member (`peer`) does NOT mark");
ok(nonMemberChatTrust("principal") === false, "negative control: a roster admin (`principal`) does NOT mark");
ok(
  nonMemberChatTrust("relay") === false,
  "🔴 negative control: `relay` (a MACHINE author — bot / webhook / another agent) does NOT mark, even though it sits below `peer` — the ruling is about a non-member PERSON, and marking every app post would set the bit on most conversational turns",
);

const ALL_TIERS: readonly WakeTrust[] = ["principal", "peer", "relay", "unauth"];
eq(ALL_TIERS.filter(nonMemberChatTrust), ["unauth"], "exactly one of the four wake-trust tiers marks");

console.log("2. the join over an ingested set:");

ok(chatWakeIngestsNonMember([{ trust: "peer" }]) === false, "a member-authored trigger alone does not mark");
ok(chatWakeIngestsNonMember([{ trust: "unauth" }]) === true, "a non-member-authored trigger marks");
ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, { trust: "peer" }, { trust: "unauth" }]) === true,
  "🔴 INGESTION, NOT PRESENCE: a MEMBER's trigger whose backscroll hydrates a guest's earlier message DOES mark — the guest's bytes entered the context",
);
ok(
  chatWakeIngestsNonMember([{ trust: "principal" }, { trust: "peer" }, { trust: "relay" }]) === false,
  "negative control: admins, members and bots together still do not mark",
);
ok(chatWakeIngestsNonMember([]) === false, "an empty ingested set marks nothing");
ok(chatWakeIngestsNonMember([{}, { trust: "peer" }]) === false, "an entry with no readable tier is SKIPPED, never assumed — the leg fails OPEN");

console.log("3. the stamp:");

eq(nonMemberChatAttrs(true), { [OE_CHAT_NONMEMBER_ATTR]: "true" }, "the producer emits the one host-set attribute");
eq(nonMemberChatAttrs(false), {}, "…and an EMPTY bag otherwise — nothing downstream has to reason about a `\"false\"` string");

const memberAuth = { authenticator: "slack", attributes: { team_id: "T1" } as Record<string, unknown> };
ok(
  stampNonMemberChatAuth(memberAuth, [{ trust: "peer" }]) === memberAuth,
  "🔴 BYTE-IDENTICAL FOR A MEMBER-ONLY WAKE: the SAME object comes back by reference, so no existing golden or attribute-order assertion can move",
);

const stamped = stampNonMemberChatAuth(memberAuth, [{ trust: "unauth" }]);
ok(stamped !== memberAuth, "a marking wake returns a NEW object — the caller's auth is never mutated");
eq(stamped.attributes[OE_CHAT_NONMEMBER_ATTR], "true", "…carrying the carriage attribute");
eq(stamped.attributes["team_id"], "T1", "…and every attribute the surface already stamped");
eq(memberAuth.attributes as Record<string, unknown>, { team_id: "T1" }, "…while the INPUT bag is untouched (purity — a shared auth object is not silently marked for another leg)");

console.log("4. the carriage:");

ok(TAINT_SEED_ATTRS.includes(OE_CHAT_NONMEMBER_ATTR), "the attribute is in TAINT_SEED_ATTRS — the ONE thing that connects the stamp to the consumer");

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

const boundary = (turnId: string, attributes: Record<string, unknown>) =>
  openTaintTurn({ session: { turn: { id: turnId }, auth: { current: { attributes } } } } as unknown as Parameters<typeof openTaintTurn>[0]);

await eveContextStorage().run(new FakeSession(), async () => {
  const auth = stampNonMemberChatAuth({ attributes: {} as Record<string, unknown> }, [{ trust: "peer" }, { trust: "unauth" }]);
  boundary("turn-1", auth.attributes);
  ok(
    untrustedIngestedThisTurn() === true,
    "🔴 END TO END: a chat wake carrying the stamp SEEDS the reading turn — the ingress render's own `ingestUntrusted` never could, because it runs outside any turn",
  );
});

await eveContextStorage().run(new FakeSession(), async () => {
  const auth = stampNonMemberChatAuth({ attributes: { team_id: "T1" } as Record<string, unknown> }, [{ trust: "peer" }, { trust: "principal" }]);
  ok(auth.attributes[OE_CHAT_NONMEMBER_ATTR] === undefined, "a member-only wake carries NO carriage attribute");
  boundary("turn-1", auth.attributes);
  ok(untrustedIngestedThisTurn() === false, "🔴 NEGATIVE CONTROL: the same boundary over a member-only wake leaves the turn CLEAN — the slot is `=== false`, not merely unset");
});

await eveContextStorage().run(new FakeSession(), async () => {
  boundary("turn-1", { [OE_CHAT_NONMEMBER_ATTR]: "true" });
  ok(untrustedIngestedThisTurn() === true, "turn 1 (the wake that carried the guest's message) is marked");
  boundary("turn-2", {});
  ok(
    untrustedIngestedThisTurn() === false,
    "🔴 the NEXT turn of the SAME session is CLEAN — a later message arrives on a plain ingress token with no stamp, so the mark does not become session-durable (OPE-299 §A)",
  );
});

await eveContextStorage().run(new FakeSession(), async () => {
  boundary("turn-1", { [OE_CHAT_NONMEMBER_ATTR]: ["true"] });
  ok(untrustedIngestedThisTurn() === true, "the ARRAY spelling eve can hand back also seeds — the same collapse every other stamp reader makes");
});

console.log("5. the table is untouched:");

eq(
  classifyIngestion({ kind: "chat-message" }).tier,
  "trusted",
  "🔴 the `chat-message` row still says TRUSTED — this leg carries its own signal and deliberately does NOT route through the table",
);
ok(
  decideIngestion({ kind: "chat-message" }, false) === false,
  "🔴 THE DIRECTION INVARIANT HOLDS: enforcement is still relaxation-only, so the carve-out taint-enforcement.ts documents did NOT have to be removed for this leg",
);

console.log(`\n✅ chat non-member taint: ${passed} assertions passed`);
