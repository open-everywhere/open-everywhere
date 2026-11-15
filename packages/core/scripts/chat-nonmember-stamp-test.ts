import assert from "node:assert/strict";

import {
  nonMemberChatTrust,
  chatRoomMarks,
  chatWakeIngestsNonMember,
  nonMemberChatAttrs,
  stampNonMemberChatAuth,
  OE_CHAT_NONMEMBER_ATTR,
} from "../agent/identity/non-member.js";
import { defineSurface, registerSurfaces, _resetSurfacesForTest } from "../agent/identity/trust.js";
import { defineAuthorTrust, registerAuthorTrust, _resetAuthorTrustForTest } from "../agent/identity/author-trust.js";
import { defineSettings, getSettings, overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import type { WakeTrust } from "../agent/channels/wake-envelope.js";
import {
  OE_CHAT_NONMEMBER_ATTR as LEGACY_ATTR,
  nonMemberChatAttrs as legacyAttrs,
  nonMemberChatTrust as legacyTrust,
  chatRoomMarks as legacyRoomMarks,
  chatWakeIngestsNonMember as legacyJoin,
  stampNonMemberChatAuth as legacyStamp,
} from "../agent/access/taint-signal.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("chat-nonmember-stamp");

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

console.log("1b. the author leg's register source (OPE-516):");

const GUILD = "discord/1300000000000000100";
const INSIDER = { tenantKey: GUILD, authorId: "100000000000000001" };
const OUTSIDER = { tenantKey: GUILD, authorId: "100000000000000002" };

ok(
  nonMemberChatTrust({ trust: "peer", authorTrust: OUTSIDER }) === false,
  "🔴 with the register UNARMED, an author query changes nothing — silence is not a declaration",
);

try {
  registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [`discord/100000000000000001`] })]);

  ok(
    nonMemberChatTrust({ trust: "peer", authorTrust: OUTSIDER }) === true,
    "🔴 an UNDECLARED author on an ARMED guild marks — this is the leg Discord and Notion never had",
  );
  ok(
    nonMemberChatTrust({ trust: "peer", authorTrust: INSIDER }) === false,
    "negative control: a DECLARED author does NOT mark (=== false)",
  );
  ok(
    nonMemberChatTrust({ trust: "relay", authorTrust: OUTSIDER }) === false,
    "🔴 negative control: a MACHINE author never marks through the register — every app posting in a busy guild is `relay`, and grading them would rebuild the always-on bit",
  );
  ok(
    nonMemberChatTrust({ authorTrust: OUTSIDER }) === false,
    "🔴 negative control: an entry the surface never GRADED is not graded here either (=== false) — the leg needs a positively-human tier",
  );
  eq(
    ALL_TIERS.filter((t) => nonMemberChatTrust({ trust: t, authorTrust: OUTSIDER })),
    ["principal", "peer", "unauth"],
    "exhaustive: the register leg marks on every HUMAN tier and only on those",
  );
  eq(
    ALL_TIERS.filter((t) => nonMemberChatTrust({ trust: t, authorTrust: INSIDER })),
    [],
    "negative control: a declared author marks on NO tier",
  );

  try {
    registerSurfaces([defineSurface({ key: `${GUILD}/C_LOUNGE`, trust: "public" })]);
    ok(
      chatWakeIngestsNonMember([{ trust: "peer", authorTrust: INSIDER }], { surfaceKey: `${GUILD}/C_LOUNGE` }) === true,
      "🔴 ADDITIVE, NOT A REPLACEMENT: a TRUSTED author in a room declared `public` STILL marks — the room gates AUDIENCE, the register gates AUTHORITY",
    );
  } finally {
    _resetSurfacesForTest();
  }
  ok(
    chatWakeIngestsNonMember([{ trust: "peer", authorTrust: OUTSIDER }], {}) === true,
    "…and conversely an UNDECLARED author marks with no room declaration at all — neither leg needs the other",
  );
} finally {
  _resetAuthorTrustForTest();
}

ok(
  nonMemberChatTrust({ trust: "peer", authorTrust: OUTSIDER }) === false,
  "after the reset the register is disarmed again (the register is not sticky across tests)",
);

console.log("2. the room leg:");

const ROOM = { surfaceKey: "slack/T0/C_LOUNGE" };
try {
  _resetSurfacesForTest();
  ok(chatRoomMarks(ROOM) === false, "UNDECLARED stamps nothing under the shipped `identity.undeclaredSurface: \"clean\"` — the loudness lives at config time instead");

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
    "🔴 MOST SPECIFIC WINS reaches the stamp: a PUBLIC carve-out beats the internal tenant it sits under",
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

console.log("2a. the strict knob, and its alias:");

function strictKnobLegs(spelling: string): void {
  _resetSurfacesForTest();
  ok(
    chatRoomMarks(ROOM) === true,
    `🔴 ${spelling}: "mark" stamps an UNDECLARED room as non-member — the deployer's fail-closed posture, in one reviewed line`,
  );
  registerSurfaces([defineSurface({ key: "slack/T0", trust: "internal" })]);
  ok(chatRoomMarks(ROOM) === false, `🔴 ${spelling}: …and a DECLARED room never reaches the knob at all`);
  ok(chatRoomMarks({ surfaceKey: "slack/T0/C_X", dm: true }) === false, `${spelling}: the knob does not reach a DM either — a DM has no room leg in any posture`);
}

for (const [spelling, patch] of [
  ["identity.undeclaredSurface", { identity: { undeclaredSurface: "mark" } }],
  ["the deprecated alias taint.undeclaredSurface", { taint: { undeclaredSurface: "mark" } }],
  ["both keys, agreeing", { identity: { undeclaredSurface: "mark" }, taint: { undeclaredSurface: "mark" } }],
] as const) {
  try {
    overrideSettingsForTest(patch);
    strictKnobLegs(spelling);
  } finally {
    _resetSurfacesForTest();
    resetSettingsForTest();
  }
}

for (const patch of [{ identity: { undeclaredSurface: "clean" } }, { taint: { undeclaredSurface: "clean" } }] as const) {
  try {
    overrideSettingsForTest(patch);
    _resetSurfacesForTest();
    ok(chatRoomMarks(ROOM) === false, `an explicit "clean" (${Object.keys(patch)[0]}.undeclaredSurface) stamps no undeclared room`);
  } finally {
    resetSettingsForTest();
  }
}

for (const patch of [{ identity: { undeclaredSurface: "mark" } }, { taint: { undeclaredSurface: "mark" } }, {}] as const) {
  const want = Object.keys(patch).length === 0 ? "clean" : "mark";
  eq(
    [getSettings(patch).identity.undeclaredSurface, getSettings(patch).taint.undeclaredSurface],
    [want, want],
    `the new key and the alias resolve to the same value (${JSON.stringify(patch)} → ${want})`,
  );
}

assert.throws(
  () => defineSettings({ identity: { undeclaredSurface: "clean" }, taint: { undeclaredSurface: "mark" } }),
  /identity\.undeclaredSurface is "clean" but its deprecated alias taint\.undeclaredSurface is "mark"/,
  "a config that declares the two keys with different values fails to load",
);
passed += 1;
console.log("  ✓ 🔴 a config that declares the new key and the alias with DIFFERENT values fails to load");
ok(
  Object.isFrozen(defineSettings({ identity: { undeclaredSurface: "mark" }, taint: { undeclaredSurface: "mark" } })),
  "…while two keys that AGREE load",
);
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
console.log("4. the public names (OPE-2711):");

eq(OE_CHAT_NONMEMBER_ATTR, "oe_chat_nonmember", "🔴 the stamp's key is unchanged — every guest control and every persisted row reads this exact string");
{
  const api = (await import("@open-everywhere/core/agent/adapter-api.js")) as Record<string, unknown>;
  const builtHome: Record<string, unknown> = await (async () => {
    const { OE_CHAT_NONMEMBER_ATTR, nonMemberChatAttrs, nonMemberChatTrust, chatWakeIngestsNonMember, stampNonMemberChatAuth } =
      await import("@open-everywhere/core/agent/identity/non-member.js");
    return { OE_CHAT_NONMEMBER_ATTR, nonMemberChatAttrs, nonMemberChatTrust, chatWakeIngestsNonMember, stampNonMemberChatAuth };
  })();
  eq(builtHome["OE_CHAT_NONMEMBER_ATTR"], OE_CHAT_NONMEMBER_ATTR, "the built identity/non-member.js carries the same stamp key");
  const legacy: Record<string, unknown> = {
    OE_CHAT_NONMEMBER_ATTR: LEGACY_ATTR,
    nonMemberChatAttrs: legacyAttrs,
    nonMemberChatTrust: legacyTrust,
    chatWakeIngestsNonMember: legacyJoin,
    stampNonMemberChatAuth: legacyStamp,
  };
  const moved = { OE_CHAT_NONMEMBER_ATTR, nonMemberChatAttrs, nonMemberChatTrust, chatWakeIngestsNonMember, stampNonMemberChatAuth } as const;
  for (const [name, value] of Object.entries(moved)) {
    ok(builtHome[name] !== undefined && api[name] === builtHome[name], `🔴 the built adapter-api.js still exports \`${name}\`, and it IS the identity/non-member.js value — a provider bundle that imports it still builds and still stamps`);
    ok(legacy[name] === value, `the deprecated access/taint-signal.ts name \`${name}\` IS the same value (one release, OPE-2721 decides it)`);
  }
  ok(legacyRoomMarks === chatRoomMarks, "the deprecated access/taint-signal.ts name `chatRoomMarks` IS the same value");
}

console.log(`\n✅ chat non-member stamp: ${passed} assertions passed`);
