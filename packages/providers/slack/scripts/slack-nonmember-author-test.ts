import assert from "node:assert/strict";

import { chatWakeIngestsNonMember, type WakeMessageInput } from "@open-everywhere/core/agent/adapter-api.js";
import { partnerFactsFromInfo } from "../agent/channels/slack-identity.js";
import { slackAuthorIsMember, slackWakeSurfaceInternal, regradeSlackBackscrollTrust, type SlackMemberProbe } from "../agent/channels/slack-events.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function fakeProbe(members: Record<string, boolean>): SlackMemberProbe {
  return async (userId) => (userId in members ? members[userId] : undefined);
}
const PROBE = fakeProbe({ U_MEMBER: true, U_GUEST: false, U_STRANGER: false });

console.log("1. the composed surface fact:");

ok(
  (await slackWakeSurfaceInternal(true, "U_GUEST", "T1", PROBE)) === false,
  "🔴 a GUEST in a confirmed-internal channel makes the surface fact FALSE — which is what drives resolveWakeTrust to `unauth` instead of `peer`",
);
ok((await slackWakeSurfaceInternal(true, "U_MEMBER", "T1", PROBE)) === true, "negative control: a full member in the same room leaves it TRUE — no over-narrowing");
ok((await slackWakeSurfaceInternal(false, "U_MEMBER", "T1", PROBE)) === false, "negative control: an UNCONFIRMED room stays false regardless of the author — the channel gate still decides first");
ok(
  (await slackWakeSurfaceInternal(true, undefined, "T1", PROBE)) === true,
  "an author with NO id is not narrowed here — `wakeTrustFor` already answers `unauth` for an unidentifiable human, and narrowing twice would say nothing new",
);

console.log("2. the fail direction:");

ok(
  (await slackWakeSurfaceInternal(true, "U_UNKNOWN_TO_THE_PROBE", "T1", PROBE)) === true,
  "🔴 an UNRESOLVABLE author reads as a member: this leg governs a MARK, and failing closed would taint EVERY chat wake in a workspace whose token lacks `users:read`",
);

delete process.env["SLACK_BOT_TOKEN"];
ok((await slackAuthorIsMember("U_ANY", "T1")) === undefined, "the LIVE probe answers `undefined` (never a guess) when no bot token is configured");
ok((await slackAuthorIsMember("", "T1")) === undefined, "…and refuses an empty author id without spending a call");

console.log("3. backscroll re-grading:");

const sibling = (authorId: string, trust: WakeMessageInput["trust"], from: WakeMessageInput["from"] = "human"): WakeMessageInput => ({
  from,
  author: authorId,
  authorId,
  id: `m-${authorId}`,
  sentAt: "2026-08-13T10:00:00.000Z",
  trust,
  body: "hello",
});

const memberOnly = [sibling("U_MEMBER", "peer"), sibling("U_MEMBER", "principal")];
ok(
  (await regradeSlackBackscrollTrust(memberOnly, "T1", PROBE)) === memberOnly,
  "🔴 a member-only bundle comes back as the SAME ARRAY by reference — the common case cannot move a byte of the render",
);

const mixed = [sibling("U_MEMBER", "peer"), sibling("U_GUEST", "peer"), sibling("BOT", "relay", "bot")];
const graded = await regradeSlackBackscrollTrust(mixed, "T1", PROBE);
ok(graded[0].trust === "peer", "the member sibling keeps `peer`");
ok(graded[1].trust === "unauth", "🔴 the GUEST sibling is demoted to `unauth` — so the envelope renders the reference-only system note AND the taint join sees it");
ok(graded[2].trust === "relay", "negative control: the BOT sibling keeps `relay` — a machine author is never re-graded, and is never probed");

const alreadyUnauth = [sibling("U_GUEST", "unauth")];
ok((await regradeSlackBackscrollTrust(alreadyUnauth, "T1", PROBE)) === alreadyUnauth, "an already-`unauth` sibling needs no probe and is returned untouched");

const unresolvable = [sibling("U_UNKNOWN_TO_THE_PROBE", "peer")];
ok((await regradeSlackBackscrollTrust(unresolvable, "T1", PROBE)) === unresolvable, "negative control: an UNRESOLVABLE sibling keeps its tier — down-only, and only on a positive refutation");

let calls = 0;
const counting: SlackMemberProbe = async (userId) => {
  calls += 1;
  return userId === "U_GUEST" ? false : true;
};
await regradeSlackBackscrollTrust([sibling("U_A", "peer"), sibling("U_A", "peer"), sibling("U_A", "peer"), sibling("U_GUEST", "peer")], "T1", counting);
ok(calls === 2, "the probe runs once per DISTINCT author (2 for 4 messages), because it is a rate-limited API call");

console.log("4. the guest vocabulary:");

const trustOf = (user: Record<string, unknown>): string => partnerFactsFromInfo({ user }, "T1").dmPartnerTrust;
ok(trustOf({ team_id: "T1" }) === "internal", "a full member of the expected workspace is internal");
ok(trustOf({ team_id: "T1", is_restricted: true }) === "external", "a multi-channel guest is a non-member");
ok(trustOf({ team_id: "T1", is_ultra_restricted: true }) === "external", "a single-channel guest is a non-member");
ok(trustOf({ team_id: "T1", is_stranger: true }) === "external", "a Slack-Connect stranger is a non-member");
ok(trustOf({ team_id: "T_OTHER" }) === "external", "a person from ANOTHER workspace is a non-member");

console.log("5. the join over the re-graded bundle:");

ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...graded]) === true,
  "🔴 INGESTION, NOT PRESENCE: a MEMBER's trigger whose first-wake backscroll hydrates a guest's earlier message marks the wake",
);
ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...(await regradeSlackBackscrollTrust(memberOnly, "T1", PROBE))]) === false,
  "negative control: the same trigger over a member-only bundle does NOT mark",
);

console.log(`\n✅ slack non-member author: ${passed} assertions passed`);
