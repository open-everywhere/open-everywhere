import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  nonMemberChatTrust,
  chatRoomMarks,
  chatWakeIngestsNonMember,
  nonMemberChatAttrs,
  stampNonMemberChatAuth,
  untrustedIngestedThisTurn,
  OE_CHAT_NONMEMBER_ATTR,
} from "../agent/access/taint-signal.js";
import { TAINT_SEED_ATTRS, openTaintTurn } from "../agent/hooks/spawn-taint.js";
import { defineSurface, registerSurfaces, _resetSurfacesForTest } from "../agent/identity/trust.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
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

console.log("1. the author leg:");

ok(
  nonMemberChatTrust({ trust: "unauth", refuted: true }) === true,
  "🔴 a POSITIVELY REFUTED human author marks — the surface's probe said guest / stranger / out-of-tenant",
);
ok(
  nonMemberChatTrust({ trust: "unauth" }) === false,
  "🔴 BARE `unauth` DOES NOT MARK (OPE-489 design B). It is a three-way disjunction, and its third case — a human on a surface the gate never confirmed — is the DEFAULT state of an unconfigured Discord/Teams/Notion deployment, so marking on it set the bit on every human turn and the signal stopped discriminating",
);
ok(nonMemberChatTrust({ trust: "peer" }) === false, "negative control: a vouched member (`peer`) does NOT mark");
ok(nonMemberChatTrust({ trust: "principal" }) === false, "negative control: a roster admin (`principal`) does NOT mark");
ok(
  nonMemberChatTrust({ trust: "relay", refuted: true }) === false,
  "🔴 negative control: `relay` (a MACHINE author — bot / webhook / another agent) does NOT mark EVEN WHEN REFUTED — the ruling is about a non-member PERSON, and marking every app post would set the bit on most conversational turns",
);
ok(nonMemberChatTrust({ refuted: false }) === false, "an explicit `refuted: false` does not mark");
ok(nonMemberChatTrust({}) === false, "an ungraded entry does not mark — absence of evidence, and this leg fails OPEN");

const ALL_TIERS: readonly WakeTrust[] = ["principal", "peer", "relay", "unauth"];
eq(
  ALL_TIERS.filter((t) => nonMemberChatTrust({ trust: t, refuted: true })),
  ["principal", "peer", "unauth"],
  "with a refutation in hand, every HUMAN tier marks and only the machine tier does not",
);
eq(ALL_TIERS.filter((t) => nonMemberChatTrust({ trust: t })), [], "🔴 with NO refutation, NO tier marks on its own");

console.log("2. the room leg:");

const ROOM = { surfaceKey: "slack/T0/C_LOUNGE" };
try {
  _resetSurfacesForTest();
  ok(chatRoomMarks(ROOM) === false, "UNDECLARED marks nothing under the shipped `taint.undeclaredSurface: \"clean\"` — the loudness lives at config time instead");

  registerSurfaces([defineSurface({ key: "slack/T0/C_LOUNGE", trust: "public" })]);
  ok(chatRoomMarks(ROOM) === true, "🔴 a room the operator DECLARED PUBLIC marks — anyone can type there, so there is nothing to probe per author");

  registerSurfaces([defineSurface({ key: "slack/T0", trust: "internal" })]);
  ok(chatRoomMarks(ROOM) === false, "a room under an INTERNAL declaration does not mark — the author leg still runs and still catches a guest");

  registerSurfaces([
    defineSurface({ key: "slack/T0", trust: "internal" }),
    defineSurface({ key: "slack/T0/C_LOUNGE", trust: "public" }),
  ]);
  ok(
    chatRoomMarks(ROOM) === true,
    "🔴 MOST SPECIFIC WINS reaches the taint plane: a PUBLIC carve-out beats the internal tenant it sits under",
  );
  ok(chatRoomMarks({ surfaceKey: "slack/T0/C_ENG" }) === false, "…and its sibling, covered only by the internal tenant, still does not mark");
  ok(
    chatRoomMarks({ surfaceKey: "slack/T0/C_LOUNGE", dm: true }) === false,
    "🔴 A DM HAS NO ROOM LEG: on a DM the trust plane asks about the PARTNER, not about the room, so a room declaration means something else there and is out of scope",
  );
  ok(chatRoomMarks({}) === false, "a wake with no resolvable room key contributes no room leg (fail-open, like every carriage leg here)");
  ok(chatRoomMarks({ surfaceKey: "slack/T0" }) === false, "a TENANT-grain key is not a room — nothing to resolve");

  registerSurfaces([defineSurface({ key: "slack/T_OTHER", trust: "public" })]);
  ok(
    chatRoomMarks(ROOM) === false,
    "🔴 UNDECLARED IS NOT PUBLIC: another workspace's public declaration says nothing here — \"we could not ask\" must never read as \"we asked and it was fine\"",
  );
} finally {
  _resetSurfacesForTest();
}

console.log("2a. the strict knob:");

try {
  overrideSettingsForTest({ taint: { undeclaredSurface: "mark" } });
  _resetSurfacesForTest();
  ok(
    chatRoomMarks(ROOM) === true,
    "🔴 `taint.undeclaredSurface: \"mark\"` makes an UNDECLARED room mark every human-authored turn — the deployer's fail-closed posture, in one reviewed line",
  );
  registerSurfaces([defineSurface({ key: "slack/T0", trust: "internal" })]);
  ok(
    chatRoomMarks(ROOM) === false,
    "🔴 …and it is MUCH narrower than the pre-OPE-489 behaviour: a DECLARED room never reaches the knob at all",
  );
  ok(chatRoomMarks({ surfaceKey: "slack/T0/C_X", dm: true }) === false, "the knob does not reach a DM either — a DM has no room leg in any posture");
} finally {
  _resetSurfacesForTest();
  resetSettingsForTest();
}
ok(chatRoomMarks({ surfaceKey: "slack/T_UNSET/C_X" }) === false, "…and the shipped default is back to `clean` after the reset (the knob is not sticky)");

console.log("2b. the join over an ingested set:");

const NO_ROOM = {};
ok(chatWakeIngestsNonMember([{ trust: "peer" }], NO_ROOM) === false, "a member-authored trigger alone does not mark");
ok(chatWakeIngestsNonMember([{ trust: "unauth", refuted: true }], NO_ROOM) === true, "a refuted trigger author marks");
ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, { trust: "peer" }, { trust: "unauth", refuted: true }], NO_ROOM) === true,
  "🔴 INGESTION, NOT PRESENCE: a MEMBER's trigger whose backscroll hydrates a guest's earlier message DOES mark — the guest's bytes entered the context",
);
ok(
  chatWakeIngestsNonMember([{ trust: "principal" }, { trust: "peer" }, { trust: "relay" }], NO_ROOM) === false,
  "negative control: admins, members and bots together still do not mark",
);
ok(chatWakeIngestsNonMember([], NO_ROOM) === false, "an empty ingested set marks nothing");
ok(chatWakeIngestsNonMember([{}, { trust: "peer" }], NO_ROOM) === false, "an entry with no readable grade is SKIPPED, never assumed — the leg fails OPEN");

try {
  registerSurfaces([defineSurface({ key: "slack/T0/C_LOUNGE", trust: "public" })]);
  ok(
    chatWakeIngestsNonMember([{ trust: "peer" }], ROOM) === true,
    "🔴 THE ROOM LEG CARRIES A WAKE THE AUTHOR LEG CANNOT: every author reads as a member, and the room is still declared public",
  );
  ok(
    chatWakeIngestsNonMember([], ROOM) === true,
    "…and it does not need an ingested message to fire — the room itself is the statement (this is Discord's and Notion's ONLY leg)",
  );
} finally {
  _resetSurfacesForTest();
}

console.log("3. the stamp:");

eq(nonMemberChatAttrs(true), { [OE_CHAT_NONMEMBER_ATTR]: "true" }, "the producer emits the one host-set attribute");
eq(nonMemberChatAttrs(false), {}, "…and an EMPTY bag otherwise — nothing downstream has to reason about a `\"false\"` string");

const memberAuth = { authenticator: "slack", attributes: { team_id: "T1" } as Record<string, unknown> };
ok(
  stampNonMemberChatAuth(memberAuth, [{ trust: "peer" }], {}) === memberAuth,
  "🔴 BYTE-IDENTICAL FOR A MEMBER-ONLY WAKE: the SAME object comes back by reference, so no existing golden or attribute-order assertion can move",
);

const stamped = stampNonMemberChatAuth(memberAuth, [{ trust: "unauth", refuted: true }], {});
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
  const auth = stampNonMemberChatAuth({ attributes: {} as Record<string, unknown> }, [{ trust: "peer" }, { trust: "unauth", refuted: true }], {});
  boundary("turn-1", auth.attributes);
  ok(
    untrustedIngestedThisTurn() === true,
    "🔴 END TO END: a chat wake carrying the stamp SEEDS the reading turn — the ingress render's own `ingestUntrusted` never could, because it runs outside any turn",
  );
});

await eveContextStorage().run(new FakeSession(), async () => {
  const auth = stampNonMemberChatAuth({ attributes: { team_id: "T1" } as Record<string, unknown> }, [{ trust: "peer" }, { trust: "principal" }], {});
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
