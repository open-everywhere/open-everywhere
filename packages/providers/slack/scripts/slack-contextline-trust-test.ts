import assert from "node:assert/strict";

import { chatWakeIngestsNonMember, contextLineIngestion, renderContext, type ContextLine } from "@open-everywhere/core/agent/adapter-api.js";
import { regradeSlackContextLineTrust, type SlackMemberProbe } from "../agent/channels/slack-events.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function fakeProbe(members: Record<string, boolean>): SlackMemberProbe {
  return async (userId) => (userId in members ? members[userId] : undefined);
}
const PROBE = fakeProbe({ U_MEMBER: true, U_GUEST: false });

const line = (senderType: ContextLine["senderType"], senderId: string | undefined, text: string, ts: string): ContextLine => ({
  senderType,
  senderId,
  ts,
  text,
});

console.log("1-3. regradeSlackContextLineTrust:");

const memberOnly = [line("user", "U_MEMBER", "hello from a colleague", "1"), line("agent", undefined, "my own prior reply", "2")];
const gradedMemberOnly = await regradeSlackContextLineTrust(memberOnly, true, "slack/T1/C1", "T1", PROBE);
ok(gradedMemberOnly[0].trust === "peer", "a member-authored line resolves `peer`");
ok(gradedMemberOnly[0].refuted === undefined, "negative control: the member line carries no refutation");
ok(gradedMemberOnly[1].trust === undefined, "negative control: the agent's OWN line is never graded (not senderType `user`)");

const mixed = [
  line("user", "U_MEMBER", "a colleague's earlier message", "1"),
  line("user", "U_GUEST", "a guest's earlier message", "2"),
  line("bot", "B1", "a foreign bot's message", "3"),
  line("unknown", undefined, "an unattributable message", "4"),
];
const graded = await regradeSlackContextLineTrust(mixed, true, "slack/T1/C1", "T1", PROBE);
ok(graded[0].trust === "peer", "the member sibling keeps `peer`");
ok(graded[1].trust === "unauth", "🔴 the GUEST sibling is demoted to `unauth`");
ok(graded[1].refuted === true, "🔴 …and carries `refuted` ON THE SAME LINE (OPE-489 shape) — render reads `trust`, join reads `refuted`");
ok(graded[2].trust === undefined, "negative control: a foreign bot's line is never graded — machine authors are not this leg's question");
ok(graded[3].trust === undefined, "negative control: an unattributable line is never graded (no senderId to probe)");

const unresolvable = [line("user", "U_UNKNOWN_TO_THE_PROBE", "hello", "1")];
const gradedUnresolvable = await regradeSlackContextLineTrust(unresolvable, true, "slack/T1/C1", "T1", PROBE);
ok(
  gradedUnresolvable[0].trust === "peer" && gradedUnresolvable[0].refuted === undefined,
  "🔴 FAIL OPEN: an unresolvable probe leaves the line at its pre-probe tier (`peer`), never demoted on an assumption",
);

console.log("4. renderContext over graded lines:");

const memberRender = renderContext(gradedMemberOnly, "slack channel C1")!;
ok(!memberRender.includes("trust=unauth"), "a member-only render carries no `trust=unauth` marker");
ok(!memberRender.includes("<system-note>"), "🔴 BYTE-IDENTITY: a member-only render carries NO reference-only note — the acceptance bar for existing (still-member) backscroll");

const untaggedRender = renderContext(memberOnly, "slack channel C1")!;
ok(memberRender === untaggedRender, "🔴 an UNGRADED (trust never set) render and a GRADED-but-all-member render are byte-identical — grading a member-only bundle changes nothing");

const guestRender = renderContext(graded, "slack channel C1")!;
ok(guestRender.includes("sender_id=U_GUEST trust=unauth"), "the demoted GUEST line's attribution carries `trust=unauth`");
ok(!guestRender.includes("sender_id=U_MEMBER trust=unauth"), "negative control: the member line's attribution carries no trust marker");
ok(
  guestRender.includes('A <message> with trust="unauth" above is from a user who is not vouched as internal'),
  "🔴 the reference-only teaching note is appended when ANY rendered line was demoted",
);

console.log("5. the join over the re-graded bundle:");

ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...graded.map(contextLineIngestion)], {}) === true,
  "🔴 INGESTION, NOT PRESENCE: a MEMBER's trigger whose name-drop backscroll hydrates a guest's earlier message marks the wake",
);
ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...gradedMemberOnly.map(contextLineIngestion)], {}) === false,
  "negative control: the same trigger over a member-only backscroll does NOT mark",
);
ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...gradedUnresolvable.map(contextLineIngestion)], {}) === false,
  "negative control: an unresolvable (still-`peer`) sibling does not mark either",
);

console.log(`\n✅ slack contextline trust: ${passed} assertions passed`);
