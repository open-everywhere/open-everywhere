import assert from "node:assert/strict";

import {
  chatWakeIngestsNonMember,
  defineAuthorTrust,
  registerAuthorTrust,
  _resetAuthorTrustForTest,
  type BindableContext,
  type WakeMessageInput,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildSlackAuth, partnerFactsFromInfo } from "../agent/channels/slack-identity.js";
import {
  slackAuthorIsMember,
  slackClickerIsGuest,
  slackWakeAuthorFacts,
  regradeSlackBackscrollTrust,
  _resetAuthorMemberCache,
  type SlackMemberProbe,
} from "../agent/channels/slack-events.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";
import { renderMessages, slackMessageFiles, slackReadAdapter } from "../agent/channels/slack-read.js";
import { readChannelResult, defineDomain, registerConfig, registerSurfaces, defineSurface, type ReadAdapter, type RenderedLine } from "@open-everywhere/core/agent/adapter-api.js";
import { registerSlackProvider } from "../agent/register.js";

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

const surfaceInternalOf = async (roomInternal: boolean, userId: string | undefined, teamId: string, probe: SlackMemberProbe) =>
  (await slackWakeAuthorFacts(roomInternal, userId, teamId, probe)).surfaceInternal;

console.log("1. the composed surface fact:");

ok(
  (await surfaceInternalOf(true, "U_GUEST", "T1", PROBE)) === false,
  "🔴 a GUEST in a confirmed-internal channel makes the surface fact FALSE — which is what drives resolveWakeTrust to `unauth` instead of `peer`",
);
ok((await surfaceInternalOf(true, "U_MEMBER", "T1", PROBE)) === true, "negative control: a full member in the same room leaves it TRUE — no over-narrowing");
ok((await surfaceInternalOf(false, "U_MEMBER", "T1", PROBE)) === false, "negative control: an UNCONFIRMED room stays false regardless of the author — the channel gate still decides first");
ok(
  (await surfaceInternalOf(true, undefined, "T1", PROBE)) === true,
  "an author with NO id is not narrowed here — `wakeTrustFor` already answers `unauth` for an unidentifiable human, and narrowing twice would say nothing new",
);

console.log("2. the fail direction:");

ok(
  (await surfaceInternalOf(true, "U_UNKNOWN_TO_THE_PROBE", "T1", PROBE)) === true,
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
ok(graded[1].trust === "unauth", "🔴 the GUEST sibling is demoted to `unauth` — the envelope renders the reference-only system note");
ok(
  graded[1].refuted === true,
  "🔴 …and it carries `refuted` ON THE SAME OBJECT (OPE-489). The RENDER reads `trust`, the taint JOIN reads `refuted`, and setting both from one verdict is what stops the two consumers disagreeing about a message",
);
ok(graded[0].refuted === undefined, "negative control: the member sibling carries NO refutation");
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

console.log("3b. the trigger author's two facts:");

{
  const guest = await slackWakeAuthorFacts(true, "U_GUEST", "T1", PROBE);
  ok(guest.surfaceInternal === false && guest.refuted === true, "a GUEST narrows the wake tier AND is positively refuted — both facts, one probe call");

  const member = await slackWakeAuthorFacts(true, "U_MEMBER", "T1", PROBE);
  ok(member.surfaceInternal === true && member.refuted === false, "negative control: a full member narrows nothing and refutes nothing");

  const unknown = await slackWakeAuthorFacts(true, "U_UNKNOWN_TO_THE_PROBE", "T1", PROBE);
  ok(
    unknown.refuted === false,
    "🔴 AN UNRESOLVABLE PROBE IS NOT A REFUTATION. Absence of evidence, and this leg fails OPEN — failing closed would taint every chat wake in a workspace whose token lacks `users:read`",
  );

  const external = await slackWakeAuthorFacts(false, "U_MEMBER", "T1", PROBE);
  ok(
    external.surfaceInternal === false && external.refuted === false,
    "an EXTERNAL room narrows the tier but says nothing about the author — the two facts are different questions and must not be re-derived from each other",
  );
  const externalGuest = await slackWakeAuthorFacts(false, "U_GUEST", "T1", PROBE);
  ok(
    externalGuest.refuted === true,
    "🔴 …and a guest in an EXTERNAL room is still a refuted author. `surfaceInternal: false` is also what an external ROOM produces, so deriving the refutation from it would mark every turn in a Connect channel",
  );

  const noId = await slackWakeAuthorFacts(true, undefined, "T1", PROBE);
  ok(noId.surfaceInternal === true && noId.refuted === false, "an author with NO id refutes nothing — `wakeTrustFor` already answers `unauth`, and there is nobody to refute");
}

console.log("4. the guest vocabulary:");

const trustOf = (user: Record<string, unknown>): string => partnerFactsFromInfo({ user }, "T1").dmPartnerTrust;
ok(trustOf({ team_id: "T1" }) === "internal", "a full member of the expected workspace is internal");
ok(trustOf({ team_id: "T1", is_restricted: true }) === "external", "a multi-channel guest is a non-member");
ok(trustOf({ team_id: "T1", is_ultra_restricted: true }) === "external", "a single-channel guest is a non-member");
ok(trustOf({ team_id: "T1", is_stranger: true }) === "external", "a Slack-Connect stranger is a non-member");
ok(trustOf({ team_id: "T_OTHER" }) === "external", "a person from ANOTHER workspace is a non-member");

console.log("5. the join over the re-graded bundle:");

ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...graded], {}) === true,
  "🔴 INGESTION, NOT PRESENCE: a MEMBER's trigger whose first-wake backscroll hydrates a guest's earlier message marks the wake",
);
ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...(await regradeSlackBackscrollTrust(memberOnly, "T1", PROBE))], {}) === false,
  "negative control: the same trigger over a member-only bundle does NOT mark",
);
ok(
  chatWakeIngestsNonMember([{ trust: "unauth" }], {}) === false,
  "🔴 AND BARE `unauth` DOES NOT: a sibling that reached `unauth` some OTHER way (no author id, an unconfirmed room) still renders reference-only, but it no longer marks the turn — that third case is the default state of an unconfigured deployment",
);

console.log("6. the read leg:");

registerSlackProvider();

function slackCtx(teamId: string): BindableContext {
  const auth = buildSlackAuth({ userId: "U_MEMBER", channelId: "C1", teamId });
  return { channel: { kind: "slack" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}
const readCtx = slackCtx("T1");

const guestPage = renderMessages(
  [
    { user: "U_MEMBER", ts: "3", text: "morning" },
    { bot_id: "B1", ts: "2", text: "build green" },
    { user: "U_GUEST", ts: "1", text: "hello from outside" },
  ],
  { oldestFirst: true },
);
const memberPage = renderMessages([{ user: "U_MEMBER", ts: "1", text: "morning" }], { oldestFirst: true });

ok(
  JSON.stringify(guestPage.map((l) => [l.author, l.authorId, l.bot === true])) ===
    JSON.stringify([["U_MEMBER", "U_MEMBER", false], ["B1", undefined, true], ["U_GUEST", "U_GUEST", false]]),
  "🔴 renderMessages carries the author id BESIDE the unchanged display string, and marks a `bot_id` line a machine",
);

_resetAuthorTrustForTest();
ok(
  (await slackReadAdapter.refutedAuthorIds(readCtx, guestPage, PROBE)).length > 0,
  "🔴 THE READ LEG: a page carrying a GUEST's message marks the turn — the same probe, the same verdict, at the read seam",
);
ok(
  (await slackReadAdapter.refutedAuthorIds(readCtx, memberPage, PROBE)).length === 0,
  "🔴 negative control: a member-only page does NOT mark (=== []) — no always-mark on a read-heavy turn",
);
ok(
  (await slackReadAdapter.refutedAuthorIds(readCtx, renderMessages([{ bot_id: "B1", ts: "1", text: "beep" }], { oldestFirst: true }), PROBE)).length === 0,
  "🔴 negative control: a BOT-authored page does not mark (=== []) — a machine is below a member but is not a person outside the org",
);
ok(
  (await slackReadAdapter.refutedAuthorIds(readCtx, guestPage, fakeProbe({}))).length === 0,
  "🔴 negative control: an UNRESOLVABLE probe (no `users:read`) marks nothing (=== []) — the same OPEN fail direction as the wake leg, for the same reason",
);

{
  const seen: Array<string | undefined> = [];
  const recording: SlackMemberProbe = async (userId, teamId) => {
    seen.push(teamId);
    return PROBE(userId, teamId);
  };
  await slackReadAdapter.refutedAuthorIds(slackCtx("T-OTHER"), guestPage, recording);
  ok(seen.length === 2 && seen.every((t) => t === "T-OTHER"), "the probe is keyed by the BOUND team id, once per distinct human author (the bot is skipped)");
}

registerAuthorTrust([defineAuthorTrust({ tenant: "slack/T1", internal: ["slack/T1/U_MEMBER"] })]);
ok(
  (await slackReadAdapter.refutedAuthorIds(readCtx, guestPage, fakeProbe({}))).length > 0,
  "🔴 armed register: an author the surface probe could not resolve is still refuted by the OPERATOR's declaration — the two sources are additive",
);
ok(
  (await slackReadAdapter.refutedAuthorIds(readCtx, memberPage, fakeProbe({}))).length === 0,
  "negative control: …and a DECLARED author is not (=== [])",
);
_resetAuthorTrustForTest();

{
  registerConfig({
    loadDomains: () => [defineDomain({ name: "join-fixture", reach: ["slack/T1/C1"], externalPolicy: { authorGrain: "withhold" } })],
    loadSilos: () => [],
    loadBundles: () => [],
    loadBindings: () => [],
    domainsForSurface: () => [],
    pluginRegistry: {},
    skillContent: {},
  });

  const page = [{ user: "U_MEMBER", ts: "1", text: "hello there" }, { user: "U_GUEST", ts: "2", text: "hi back" }];
  const memberOnly = [{ user: "U_MEMBER", ts: "1", text: "hello there" }];
  const joined = (raw: readonly Record<string, unknown>[]): ReadAdapter =>
    ({
      platform: "slack",
      wakeAddress: () => undefined,
      readChannel: async (ctx: BindableContext, channel: string, limit?: number) =>
        await slackReadAdapter.readChannel(ctx, channel, limit, async () => ({ messages: raw }) as never),
      readThread: async (ctx: BindableContext, channel: string, threadTs: string, limit?: number) =>
        await slackReadAdapter.readThread(ctx, channel, threadTs, limit, async () => ({ messages: raw }) as never),
      refutedAuthorIds: async (ctx: BindableContext, lines: readonly RenderedLine[]) => await slackReadAdapter.refutedAuthorIds(ctx, lines, PROBE),
    }) as unknown as ReadAdapter;

  const { WITHHELD_BODY_MARKER } = await import("@open-everywhere/core/agent/adapter-api.js");
  const marked = await readChannelResult(readCtx, "slack", joined(page), "C1");
  const byAuthor = (a: string) => marked.messages.find((m) => m.author === a)?.text;
  ok(byAuthor("U_GUEST") === WITHHELD_BODY_MARKER, "🔴 THE JOIN: the REAL slackReadAdapter's refuted ids reach readChannelResult, and the guest's text is withheld — the shape the two halves agree on is pinned here, not assumed");
  ok(byAuthor("U_MEMBER") === "hello there", "the join: the member's line on the same page is untouched");
  ok(marked.count === 2, "the join: the page comes back whole (a withheld line is replaced, never dropped)");

  const clean = await readChannelResult(readCtx, "slack", joined(memberOnly), "C1");
  ok(clean.messages.every((m) => m.text !== WITHHELD_BODY_MARKER), "🔴 NEGATIVE CONTROL: a member-only page joined the same way withholds nothing — so the positive above is the guest, not an always-withhold");
}

console.log("7. an absent workspace at the live probe:");

process.env["SLACK_BOT_TOKEN"] = "xoxb-test-nonmember-author";

let infoBody: unknown = { ok: false, error: "unset" };
const fakeUsersInfo = (async (input: unknown) => {
  const url = input instanceof URL ? input : new URL(String(input));
  const op = url.pathname.split("/").pop() ?? "";
  const body = op === "users.info" ? infoBody : { ok: false, error: `unmocked_op:${op}` };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

await withPatchedFetch(fakeUsersInfo, async () => {
  registerSurfaces([]);
  _resetAuthorMemberCache();
  infoBody = { ok: true, user: { id: "U_ABSENT", team_id: "T_HOME" } };
  ok(
    (await slackAuthorIsMember("U_ABSENT", undefined)) === false,
    "🔴 an ABSENT team id over an UNDECLARED home workspace is a positive GUEST verdict (`false`), never `undefined` — absence of a declaration infers non-member (OPE-1579)",
  );
  _resetAuthorMemberCache();
  ok(
    (await slackClickerIsGuest("U_ABSENT", undefined)) === true,
    "…and the floors' reader inverts that same verdict — one probe, so the chat mark, the member-tier clicker floor and the HITL answer floor cannot disagree about an unnamed workspace",
  );

  registerSurfaces([defineSurface({ key: "slack/T_HOME", trust: "internal" })]);
  _resetAuthorMemberCache();
  ok(
    (await slackAuthorIsMember("U_ABSENT", undefined)) === true,
    "🔴 POSITIVE CONTROL: the SAME author is a MEMBER once the operator declares `slack/T_HOME` — the walk reads the home workspace off `users.info`, so an ingress that names no workspace still vouches a declared workspace's people",
  );

  registerSurfaces([defineSurface({ key: "slack/E_GRID", trust: "internal" })]);
  _resetAuthorMemberCache();
  infoBody = { ok: true, user: { id: "U_SIB", team_id: "T_SIB", enterprise_user: { enterprise_id: "E_GRID" } } };
  ok((await slackAuthorIsMember("U_SIB", undefined)) === true, "a declared GRID vouches a sibling-workspace author whose ingress named no workspace");
  _resetAuthorMemberCache();
  infoBody = { ok: true, user: { id: "U_SIB", team_id: "T_SIB", enterprise_user: { enterprise_id: "E_OTHER" } } };
  ok(
    (await slackAuthorIsMember("U_SIB", undefined)) === false,
    "NEGATIVE CONTROL: a DIFFERENT Grid is a guest on the same shape — the declaration vouches, not the payload's shape",
  );

  _resetAuthorMemberCache();
  infoBody = { ok: true, user: { id: "U_NOTEAM", enterprise_user: { enterprise_id: "E_GRID" } } };
  ok(
    (await slackAuthorIsMember("U_NOTEAM", undefined)) === false,
    "🔴 a user object naming NO workspace is a GUEST even under a DECLARED Grid — the walk needs a workspace to look up, and it answers rather than declining",
  );

  registerSurfaces([]);
  _resetAuthorMemberCache();
  infoBody = { ok: false, error: "missing_scope" };
  ok(
    (await slackAuthorIsMember("U_ABSENT", undefined)) === undefined,
    "🔴 A FAILED ASK STILL ANSWERS NOTHING: an `ok:false` body gives `undefined` even with no team id — a missing WORKSPACE never produces that verdict, and a deployment without `users:read` still marks nothing (the fail-OPEN polarity section 2 pins)",
  );

  _resetAuthorMemberCache();
  infoBody = { ok: true, user: { id: "U_OWN", team_id: "T_HOME" } };
  ok(
    (await slackAuthorIsMember("U_OWN", "T_HOME")) === true,
    "negative control: a NAMED workspace still admits its own member with NOTHING declared — the own-workspace arm is untouched",
  );
});

registerSurfaces([]);
_resetAuthorMemberCache();
delete process.env["SLACK_BOT_TOKEN"];

{
  const upload = {
    user: "U_MEMBER",
    ts: "5",
    text: "what's in the attached image?",
    files: [
      { id: "F0C1NKEL7U0", name: "probe.png", title: "probe", mimetype: "image/png", url_private: "https://files.slack.com/files-pri/T1-F0C1NKEL7U0/probe.png", permalink: "https://x.slack.com/files/U1/F0C1NKEL7U0/probe.png" },
      { id: "F0GONE", mode: "tombstone" },
      { name: "no id" },
    ],
  };
  const [line] = renderMessages([upload], { oldestFirst: true });
  ok(JSON.stringify(line?.files) === JSON.stringify([{ id: "F0C1NKEL7U0", name: "probe.png", mimetype: "image/png" }]), `🔴 the upload's file reaches the read line as id, name and media type (got ${JSON.stringify(line?.files)})`);
  ok(!JSON.stringify(line).includes("files.slack.com") && !JSON.stringify(line).includes("permalink"), "🔴 no file URL reaches the read line");
  const [fileOnly] = renderMessages([{ user: "U_MEMBER", ts: "6", text: "", subtype: "file_share", files: [{ id: "F0ONLY", title: "notes", mimetype: "text/plain" }] }], { oldestFirst: true });
  ok(fileOnly?.files?.[0]?.id === "F0ONLY" && fileOnly.files[0].name === "notes", "a file shared with no comment is a read line, named by its title");
  ok(renderMessages([{ user: "U_MEMBER", ts: "7", text: "joined", subtype: "channel_join" }], { oldestFirst: true }).length === 0, "negative control: a system line is still skipped");
  ok(renderMessages([{ user: "U_MEMBER", ts: "8", text: "", subtype: "file_share" }], { oldestFirst: true }).length === 0, "…and a file_share line with no file left is skipped too");
  ok(!("files" in (renderMessages([{ user: "U_MEMBER", ts: "9", text: "plain" }], { oldestFirst: true })[0] ?? {})), "a line with no files carries no `files` key");
  ok(slackMessageFiles(undefined).length === 0 && slackMessageFiles([null, 3]).length === 0, "a missing or malformed `files` field reads as no files");
}
console.log(`\n✅ slack non-member author: ${passed} assertions passed`);
