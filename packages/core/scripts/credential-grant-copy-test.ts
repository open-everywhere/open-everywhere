import assert from "node:assert/strict";

import {
  approvedGrantCardText,
  declinedGrantCardText,
  expiredGrantCardText,
  grantCardActions,
  grantCardText,
  grantConsentPromptText,
  refusedGrantCardText,
} from "../agent/access/credential-grant-card.js";
import { grantApproveFailureText, grantApprovedClickText } from "../agent/access/credential-grant-click.js";
import {
  connectorDisplayName,
  GRANT_ID_LEAK_PATTERNS,
  grantActionPhrase,
  grantConversationPhrase,
  grantDuplicateRefusalText,
  grantExpiryPhrase,
  grantRequesterPhrase,
} from "../agent/access/credential-grant-copy.js";
import { credentialGrantRefusalNote } from "../agent/access/credential-grant-ask.js";
import { credentialGrantMintVerdict, grantMintRefusalMessage, type GrantMintInput, type GrantMintRefusal } from "../agent/access/credential-grant.js";
import { grantOwnerNoticeText, grantRoomNoticeText } from "../agent/access/credential-grant-notice.js";
import { grantResolutionText } from "../agent/access/credential-grant-resolution.js";
import { credentialGrantDisclosureLine, credentialGrantRefusalMessage, grantBorrowResourceLabel, grantJsonColumn, grantJsonFromColumn, grantResourceTargetLabel } from "../agent/operational/credential-grant-rows.js";
import type { CredentialGrantAskRow, CredentialGrantRefusal, CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";
import { grantToolEntry } from "../agent/tools/grant_tools.js";
import type { ReplayableToolEntry } from "../agent/access/window-gated.js";

const descriptionOf = (entry: ReplayableToolEntry | undefined): string => (entry as unknown as { description?: string } | undefined)?.description ?? "";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const NOW = Date.parse("2026-03-20T16:19:45.132Z");
const SESSION_EXPIRY = "2026-03-21T04:19:45.132Z";
const STANDING_EXPIRY = "2026-04-19T16:19:45.132Z";

const ask: CredentialGrantAskRow = {
  connector: "notion",
  createdAt: "2026-03-20T16:19:45.132Z",
  expiresAt: "2026-03-20T16:49:45.132Z",
  frozenArgs: { id: "quarterly-report" },
  id: "ask-1",
  mcpTool: "notion-fetch",
  ownerNativeId: "U-OWNER",
  ownerPlatform: "discord",
  ownerPrincipalId: "discord/G1/U-OWNER",
  ownerSlug: "ada",
  purpose: "summarise the quarter for the team",
  requestedMode: "once",
  requesterPrincipalId: "discord/G1/U-ASKER",
  resource: "Quarterly report — notion-fetch({id:quarterly-report})",
  scopeKey: "sess-1",
  status: "pending",
  toolName: "grant__ada_notion__notion_fetch_quarterly_report",
  verb: "notion_fetch",
};

const grant: Pick<CredentialGrantRow, "connector" | "mcpTool" | "expiresAt" | "mode"> = {
  connector: "notion",
  expiresAt: SESSION_EXPIRY,
  mcpTool: "notion-fetch",
  mode: "session",
};

const grantRow: CredentialGrantRow = {
  askId: ask.id,
  connector: "notion",
  createdAt: ask.createdAt,
  expiresAt: SESSION_EXPIRY,
  frozenArgs: ask.frozenArgs,
  id: "00000000-0000-4000-8000-000000000018",
  mcpTool: "notion-fetch",
  mode: "session",
  ownerPrincipalId: ask.ownerPrincipalId,
  ownerSlug: ask.ownerSlug,
  purpose: ask.purpose,
  requesterPrincipalId: ask.requesterPrincipalId,
  resource: ask.resource,
  scopeKey: ask.scopeKey,
  status: "active",
  tier: "read",
  toolName: ask.toolName,
  verb: ask.verb,
};

console.log("1. the phrase helpers:");
{
  eq(connectorDisplayName("notion"), "Notion", "the connector reads as its brand, never its wire id");
  eq(connectorDisplayName("acme"), "Acme", "an unreviewed connector capitalises rather than inventing a brand");
  eq(grantActionPhrase("notion", "notion-fetch"), "read a Notion page", "the reviewed tool says what it DOES, never what it is called");
  eq(grantActionPhrase("notion", "notion-frobnicate"), "read one thing in Notion", "an unreviewed tool still says READ — every grant is read-tier by `borrowShape`");
  eq(grantActionPhrase("notion", undefined), "read one thing in Notion", "…and a row naming no tool at all says the same, rather than nothing");

  const mintInput = (mcpTool: string): GrantMintInput => ({
    borrow: { mcpTool, rowId: "00000000-0000-4000-8000-000000000015", takenToolNames: [], targetLabel: "Quarterly report" },
    connector: "notion",
    domainGrantsConnector: true,
    liveAsk: undefined,
    liveGrant: undefined,
    ownerHandle: "Ada Lovelace",
    ownerPrincipalId: "slack/W1/U-owner",
    requesterPrincipalId: "slack/W1/U-req",
  });
  const readVerdict = credentialGrantMintVerdict(mintInput("notion-fetch"));
  ok(readVerdict.ok && readVerdict.tier === "read", "the tool the reviewed phrase describes mints at the `read` tier…");
  const writeVerdict = credentialGrantMintVerdict(mintInput("notion-create-pages"));
  eq(
    writeVerdict.ok ? "MINTED" : writeVerdict.reason,
    "write_verb_out_of_slice",
    "🔴 …and a WRITE tool is refused by name, before any ask row is written or any card is sent — which is what makes both the `read` floor phrase and the card's caution line true",
  );
  eq(
    credentialGrantMintVerdict(mintInput("notion-frobnicate")).ok ? "MINTED" : "REFUSED",
    "REFUSED",
    "NEGATIVE CONTROL: an unrecognised vendor tool is refused too — the tier classifier fails CLOSED, so the floor phrase never describes a tool that slipped through unclassified",
  );

  eq(grantConversationPhrase("#proj-chat"), "the #proj-chat conversation", "a resolved room label names the conversation");
  eq(grantConversationPhrase(undefined), "that conversation", "🔴 an unresolved one says so — it NEVER falls back to a surface id");
  eq(grantConversationPhrase(""), "that conversation", "…and an empty label is the same fallback, not an empty phrase");

  eq(grantRequesterPhrase("Ada Lovelace"), "Ada Lovelace", "a resolved requester is named");
  eq(
    grantRequesterPhrase("discord/9000000000000000003"),
    "Someone this deployment cannot name",
    "🔴 an ID-SHAPED label is DROPPED, not printed — the guard is structural, not a convention at one caller",
  );
  eq(grantConversationPhrase("#9000000000000000002"), "that conversation", "…and the same guard covers the room label a scope resolver answered with");
  eq(GRANT_ID_LEAK_PATTERNS.length, 4, "the guard and the gate share ONE list of four shapes");
  eq(
    grantRequesterPhrase(""),
    "Someone this deployment cannot name",
    "🔴 an unresolved requester is admitted in words — the principal-key fallback is the exact string the operator read on the card",
  );

  eq(grantExpiryPhrase(SESSION_EXPIRY, NOW), "for the next 12 hours (until 04:19 UTC)", "an expiry is a duration AND a clock time, never an instant");
  eq(grantExpiryPhrase(STANDING_EXPIRY, NOW), "for the next 30 days (until 19 Apr, 16:19 UTC)", "…and a long span carries the DATE, because a bare clock time reads as tonight");
  eq(grantExpiryPhrase("2026-03-20T17:19:45.132Z", NOW), "for the next 60 minutes (until 17:19 UTC)", "a short span is minutes");
  eq(grantExpiryPhrase("not-a-time", NOW), "until it expires", "🔴 an unparsable column names NO time rather than falling back to the bytes");
  eq(grantExpiryPhrase("2026-03-20T15:50:00.000Z", NOW), "until it expires (it already has)", "…and a past expiry says so instead of printing a negative span");
}

console.log("2. the target label:");
{
  eq(grantResourceTargetLabel(ask), "Quarterly report", "the label a person wrote is recovered; the machine half is dropped");
  eq(
    grantResourceTargetLabel({ ...ask, resource: "notion-fetch({id:quarterly-report})" }),
    undefined,
    "a row whose requester gave NO label recovers none, rather than reading the call as one",
  );
  eq(grantResourceTargetLabel({ ...ask, mcpTool: undefined }), undefined, "a row naming no vendor tool has no marker to anchor on, so it recovers nothing");
  eq(grantResourceTargetLabel({ ...ask, resource: "Quarterly report — notion-fetch({id:x}" }), undefined, "a column the length cap cut does not close, so no label is shown rather than a truncated one");
  eq(grantResourceTargetLabel({ ...ask, resource: "notion-fetch({id:x}) — notion-fetch({id:y})" }), "notion-fetch({id:x})", "the LAST marker wins — the label half is whatever precedes the call that closes the column");

  {
    const args = { page_id: "x", block_id: "y" };
    const resource = grantBorrowResourceLabel("Q3 board", "notion-fetch", args);
    const stored = grantJsonFromColumn(grantJsonColumn(args), "frozenArgs");
    ok(JSON.stringify(stored) !== JSON.stringify(args), "the fixture really does reorder on the way through the column — otherwise the leg below proves nothing");
    eq(grantResourceTargetLabel({ frozenArgs: args, mcpTool: "notion-fetch", resource }), "Q3 board", "the LIVE row recovers the label…");
    eq(grantResourceTargetLabel({ frozenArgs: stored, mcpTool: "notion-fetch", resource }), "Q3 board", "🔴 …and so does the STORED row, whose keys came back sorted");
    eq(
      approvedGrantCardText({ ...ask, frozenArgs: stored, resource }, { expiresAt: SESSION_EXPIRY, mode: "session" }, NOW).split("\n")[2],
      'They asked to read a Notion page — "Q3 board".',
      "…so the terminal card the owner is LEFT with still names what they approved",
    );
  }
}

console.log("3. the golden:");
{
  eq(
    grantCardText(ask, "Ada Lovelace", undefined, "#proj-chat"),
    [
      "*Ada Lovelace* asks to use your Notion account, for the #proj-chat conversation.",
      "",
      'They want to read a Notion page — "Quarterly report".',
      'Their reason: "summarise the quarter for the team"',
      "It is pinned to this one value, which they cannot change:",
      "    · `id` = `quarterly-report`",
      "They asked for: once. You choose the answer.",
      "",
      "Tap one button to answer:",
      "• *Approve once* — one call that actually reaches Notion. An attempt blocked before it is sent costs nothing and can be retried — at most 4 attempts in one turn.",
      "• *Approve for this conversation* — every call that conversation makes, until the grant expires.",
      "• *Approve for 30 days* — this one conversation, for 30 days. Wider than the two above only in TIME: no other room and no thread gets it, and no scheduled run can spend it — a person has to be here asking.",
      "• *Decline* — nothing is granted.",
      "",
      "A button is the only thing that can answer this. If the buttons are missing, or a tap seems to do nothing, nothing has been granted — the request then lapses on its own and they can raise a fresh one.",
      "Approving lets the #proj-chat conversation read a Notion page with your account — the pinned values above, and nothing else in Notion. Whichever button you press, this lends ONE thing: your Notion account doing that one job, and nothing else you can reach in Notion. Only the conversation they asked from can spend it, only while somebody is there asking, and only until it ends.",
    ].join("\n"),
    "the card",
  );

  eq(
    grantCardText({ ...ask, frozenArgs: {}, resource: "Quarterly report — notion-fetch({})" }, "", undefined, undefined).split("\n").slice(0, 5),
    [
      "*Someone this deployment cannot name* asks to use your Notion account, for that conversation.",
      "",
      'They want to read a Notion page — "Quarterly report".',
      'Their reason: "summarise the quarter for the team"',
      "Nothing is pinned down: that conversation would choose every detail of the call, which is a wider ask than pinning one thing.",
    ],
    "the card with nothing resolved and nothing pinned — the WIDER grant still says so out loud",
  );

  const buttons = grantCardText(ask, "Ada Lovelace", undefined, "#proj-chat").split("\n");
  const standingLine = buttons.find((l) => l.startsWith("• *Approve for 30 days*")) ?? "";
  const sessionLine = buttons.find((l) => l.startsWith("• *Approve for this conversation*")) ?? "";
  ok(!standingLine.includes("group"), "🔴 …and never as a \"group\", which names no configured thing an operator could check");
  ok(!standingLine.includes("a standing grant, clamped to a fixed"), "🔴 …and no longer describes only its clock, which said nothing about what it reaches");
  ok(standingLine.includes("Wider than the two above"), "🔴 …and says out loud that it is the widest button, which is the fact an owner is choosing between");
  ok(standingLine.includes("this one conversation") && !standingLine.includes("domain"), "🔴 a KEYLESS ask's standing button promises ONE conversation and names no domain");
  ok(standingLine.includes("no other room and no thread gets it"), "🔴 …and says so as an exclusion the owner can check, not only as a span of days");
  const domainLine =
    grantCardText({ ...ask, domainScopeKey: "oe-grant-domain::payments" }, "Ada Lovelace", undefined, "#proj-chat")
      .split("\n")
      .find((l) => l.startsWith("• *Approve for 30 days*")) ?? "";
  ok(
    domainLine.includes("the rooms declared into this room's domain") && domainLine.includes("those other rooms can spend it too"),
    `🔴 an ask that DOES carry a domain key names the domain it reaches, in plain words (read: ${JSON.stringify(domainLine)})`,
  );
  ok(domainLine.includes("does NOT reach a thread"), "🔴 …and only THAT arm may claim the thread exclusion, because only that arm's row has it");
  ok(domainLine !== standingLine, "🔴 NEGATIVE CONTROL: the two arms really differ — a card that rendered one sentence for both is what this pair exists to catch");
  const roomCard = grantCardText({ ...ask, domainScopeKey: "oe-grant-room::payments::slack/T1/C_PAY" }, "Ada Lovelace", undefined, "#proj-chat").split("\n");
  const roomLine = roomCard.find((l) => l.startsWith("• *Approve for 30 days*")) ?? "";
  ok(!roomLine.includes("domain") && !roomLine.includes("other rooms can spend it"), `🔴 a ROOM-keyed ask's standing button names NO domain and no sibling room (read: ${JSON.stringify(roomLine)})`);
  ok(roomLine.includes("threads included"), "🔴 …and says the threads ARE included, because every wake in the room resolves the same key");
  ok(!roomLine.includes("no thread gets it") && !roomLine.includes("does NOT reach a thread"), "🔴 …and never claims a thread exclusion, which this row has not got");
  ok(roomLine.includes("keeps working after this one ends"), "🔴 …and says the thing that makes it different from the session button: it outlives the conversation that asked");
  ok(roomLine.includes("No OTHER room gets it") && roomLine.includes("no scheduled run can spend it"), "🔴 …while carrying the two exclusions this row DOES have");
  ok(roomLine !== standingLine && roomLine !== domainLine, "🔴 NEGATIVE CONTROL: the room arm is its own sentence — folding it into either neighbour is what this block exists to catch");
  ok(
    (roomCard.at(-1) ?? "").includes("Only conversations in the asker's own room can spend it"),
    "🔴 …and the CLOSING line branches with it, because it has to hold for the widest button",
  );
  const domainTail = grantCardText({ ...ask, domainScopeKey: "oe-grant-domain::payments" }, "Ada Lovelace", undefined, "#proj-chat").split("\n").at(-1) ?? "";
  ok(
    domainTail.includes("Only the main conversation of the asker's room and of the rooms declared into its domain can spend it"),
    "🔴 …and the CLOSING line branches with it, because it has to hold for the widest button",
  );
  ok(domainTail.includes("only while somebody is there asking"), "🔴 …while BOTH arms carry the attendance bound, which holds for every mode");
  ok(
    standingLine.includes("no scheduled run can spend it") && standingLine.includes("a person has to be here asking"),
    "🔴 …and says no scheduled run can spend it, because a person has to be in the room asking",
  );
  ok(sessionLine.includes("that conversation") && !sessionLine.includes("domain"), "🔴 NEGATIVE CONTROL: the SESSION button still bounds itself to one conversation — the two buttons say different things");
  const tail = buttons.at(-1) ?? "";
  ok(!tail.includes("No other conversation gets it") && !tail.includes("No other room gets it"), `🔴 the closing line claims NO room boundary — a standing grant crosses one by ruling (read: ${JSON.stringify(tail)})`);
  ok(tail.includes("nothing else you can reach in Notion") && tail.includes("only until it ends"), "…and names the bounds that DO hold for every button: one account, one job, one expiry");

  const pinnedTail = grantCardText(ask, "Ada Lovelace", undefined, "#proj-chat").split("\n").at(-1);
  const openTail = grantCardText({ ...ask, frozenArgs: {}, resource: "Quarterly report — notion-fetch({})" }, "Ada Lovelace", undefined, "#proj-chat").split("\n").at(-1);
  eq(
    pinnedTail,
    "Approving lets the #proj-chat conversation read a Notion page with your account — the pinned values above, and nothing else in Notion. Whichever button you press, this lends ONE thing: your Notion account doing that one job, and nothing else you can reach in Notion. Only the conversation they asked from can spend it, only while somebody is there asking, and only until it ends.",
    "a PINNED grant's last line bounds it to the pinned values",
  );
  eq(
    openTail,
    "Approving lets the #proj-chat conversation read a Notion page with your account, choosing for itself which one, every time. Nothing is pinned, so this reaches whatever that tool can read in your Notion account. Whichever button you press, this lends ONE thing: your Notion account doing that one job, and nothing else you can reach in Notion. Only the conversation they asked from can spend it, only while somebody is there asking, and only until it ends.",
    "🔴 an UNPINNED grant's last line says the opposite — it never claims a bound the grant does not have",
  );
  ok(!(openTail ?? "").includes("nothing else in Notion"), "NEGATIVE CONTROL: the unpinned arm carries none of the pinned arm's reassurance");

  eq(
    grantCardActions(ask).map((a) => a.label),
    ["Approve once", "Approve for this conversation", "Approve for 30 days", "Decline"],
    "the four button labels",
  );

  eq(
    grantApprovedClickText(grant, NOW),
    "Approved. That conversation can read a Notion page with your Notion account for the next 12 hours (until 04:19 UTC). Nothing else is granted. I will tell you the first time it is used.",
    "the approval confirmation",
  );

  eq(
    grantConsentPromptText(ask, "https://example.invalid/connect/abc"),
    [
      "You need to connect your Notion account first.",
      "",
      "Open this link (it connects your account only, do not forward it), then press Approve again:",
      "https://example.invalid/connect/abc",
      "",
      "Nothing has been granted and nothing has been spent.",
    ].join("\n"),
    "the consent detour — one message carries the step AND the link, on its own line",
  );

  eq(
    grantApproveFailureText("consent_required", true),
    "Not yet — I have just sent you the link to connect your account. Nothing has been granted.",
    "🔴 the tap answer POINTS AT the connect message and never repeats the step — that duplication is what made the detour read as two",
  );

  {
    const undelivered = grantApproveFailureText("consent_required", false);
    ok(undelivered.includes("stop sending you direct messages"), "the undelivered-link answer names the owner's own stop as a reason the link did not arrive");
    ok(undelivered.includes("press Approve once more"), "…and tells them what to do after they lift it, because the ask is still pending");
    ok(undelivered.includes("ask an operator"), "…and still keeps the operator remedy for the case where this deployment cannot address them at all");
    ok(!undelivered.includes("set_dm_delivery"), "…and names no internal verb — an owner reads this, and a tool name is not a step they can take");
  }

  eq(
    credentialGrantRefusalNote("notion", "grant_already_live", {
      audience: "owner",
      conversationLabel: "#proj-chat",
      expiresAt: SESSION_EXPIRY,
      mcpTool: "notion-fetch",
      nowMs: NOW,
      ownerLabel: "Ada Lovelace",
    }),
    "The #proj-chat conversation already has this grant from you (read a Notion page, for the next 12 hours (until 04:19 UTC)). Nothing new was requested — use the grant that is already there. You can end it early — send me a direct message and ask. Until then a new request stays refused while this one is live.",
    "the duplicate refusal, OWNER-facing — the person who asked IS the owner, so it says 'you' AND offers them the end",
  );

  eq(
    credentialGrantRefusalNote("notion", "grant_already_live", {
      audience: "seat",
      conversationLabel: undefined,
      expiresAt: SESSION_EXPIRY,
      mcpTool: "notion-fetch",
      nowMs: NOW,
      ownerLabel: "Ada Lovelace",
    }),
    "That conversation already has this grant from Ada Lovelace (read a Notion page, for the next 12 hours (until 04:19 UTC)). Nothing new was requested — use the grant that is already there. Only Ada Lovelace can end it early, so a new request stays refused while this one is live.",
    "the duplicate refusal, SEAT-facing — a third party reads the owner's name, never 'you', and is offered no control the verb would refuse them",
  );

  ok(
    !credentialGrantRefusalNote("notion", "grant_already_live", {
      audience: "seat",
      conversationLabel: undefined,
      expiresAt: undefined,
      mcpTool: undefined,
      nowMs: NOW,
      ownerLabel: undefined,
    }).includes("undefined"),
    "🔴 a caller that read NO facts still gets a whole sentence — every field is optional and none of them renders as a hole",
  );

  eq(
    approvedGrantCardText(ask, { expiresAt: SESSION_EXPIRY, mode: "session" }, NOW),
    [
      "✅ APPROVED — you approved this request.",
      "",
      'They asked to read a Notion page — "Quarterly report".',
      "",
      "You approved for this conversation, for the next 12 hours (until 04:19 UTC).",
      "Tapping a button on this card now does nothing.",
    ].join("\n"),
    "the approved card",
  );

  eq(
    declinedGrantCardText(ask),
    [
      "🚫 DECLINED — you declined this request.",
      "",
      'They asked to read a Notion page — "Quarterly report".',
      "",
      "Nothing was granted and nothing was spent. Tapping a button on this card now does nothing.",
    ].join("\n"),
    "the declined card",
  );

  eq(
    expiredGrantCardText(ask, true),
    [
      "⌛ EXPIRED — this request timed out.",
      "",
      'They asked to read a Notion page — "Quarterly report".',
      "",
      "Nothing was granted and nothing was spent. Tapping a button on this card now does nothing.",
      "The person who asked has been told the request lapsed, and they can ask again if they still need it.",
    ].join("\n"),
    "the expired card",
  );

  eq(
    refusedGrantCardText(ask, "tool_absent"),
    [
      "🚫 NOT GRANTED — your Notion account could not lend this.",
      "",
      'They asked to read a Notion page — "Quarterly report".',
      "",
      "Your Notion account does not offer what they asked for, so there was nothing to lend. Nothing was granted and nothing was spent.",
      "This request is closed. Ask them to raise a fresh one if it is still needed.",
    ].join("\n"),
    "the refused card",
  );

  const DISCLOSURE = `acting as ada — used ada's Notion account to read a Notion page — "Quarterly report", for the next 12 hours (until 04:19 UTC). The reason given was "summarise the quarter for the team".`;

  eq(
    grantResolutionText(ask, { askedMode: "once", grant: grantRow, kind: "approved" }, NOW),
    [
      'ada approved the credential grant — read a Notion page — "Quarterly report".',
      "The grant is for this conversation, for the next 12 hours (until 04:19 UTC).",
      "The tool is in this conversation's tool list from the next turn.",
      "ada granted MORE than was asked: the request was for once, and the grant is for this conversation.",
      DISCLOSURE,
    ].join("\n"),
    "the room's resolution notice (approved, wider than asked)",
  );

  eq(
    grantResolutionText(ask, { askedMode: "session", grant: { ...grantRow, toolName: undefined }, kind: "approved" }, NOW),
    [
      'ada approved the credential grant — read a Notion page — "Quarterly report".',
      "The grant is for this conversation, for the next 12 hours (until 04:19 UTC).",
      DISCLOSURE,
    ].join("\n"),
    "the room's resolution notice (approved, nothing mounts)",
  );

  eq(
    grantResolutionText(ask, { kind: "declined" }, NOW),
    'ada declined the credential grant — read a Notion page — "Quarterly report". Nothing was granted and no tool is mounted. Do not ask again for the same thing — find another way, or ask the room.',
    "the room's resolution notice (declined)",
  );

  eq(
    grantResolutionText(ask, { kind: "expired" }, NOW),
    [
      'The credential grant request — read a Notion page — "Quarterly report" — expired with no answer from ada.',
      "Nothing was granted and no tool is mounted. ada did not decline — the request simply timed out.",
      "You can ask again if it is still needed.",
    ].join("\n"),
    "the room's resolution notice (expired)",
  );

  eq(
    grantResolutionText(ask, { gate: "tool_absent", kind: "refused" }, NOW),
    [
      'ada approved the credential grant — read a Notion page — "Quarterly report" — but it could not be minted.',
      "Their Notion connection publishes no tool by that name, so there was nothing to lend.",
      "Nothing was granted and no tool is mounted. Check the tool name and the arguments against the connection, then ask again.",
    ].join("\n"),
    "the room's resolution notice (refused)",
  );

  eq(
    grantOwnerNoticeText(grantRow, "Ada Lovelace", NOW),
    [
      "Your Notion credential was just used in the conversation you approved.",
      "",
      '• What it did: read a Notion page — "Quarterly report"',
      "• Who ran it: Ada Lovelace (`discord/G1/U-ASKER`)",
      "• The grant: this conversation",
      "",
      "This is the FIRST use of that grant, and the only notice you get for it. It stays live for the next 12 hours (until 04:19 UTC). Tell me here to end it and I will end it now.",
    ].join("\n"),
    "the owner's first-use DM",
  );

  eq(
    grantOwnerNoticeText({ ...grantRow, mode: "once" }, undefined, NOW),
    [
      "Your Notion credential was just used in the conversation you approved.",
      "",
      '• What it did: read a Notion page — "Quarterly report"',
      "• Who ran it: `discord/G1/U-ASKER`",
      "• The grant: once",
      "",
      "That was a one-shot grant, so it is now spent. Nothing else can be run with it.",
    ].join("\n"),
    "the owner's first-use DM (once, no label)",
  );

  eq(
    grantRoomNoticeText(DISCLOSURE, grantRow, "2026-03-20T21:19:45.132Z", "Ada Lovelace"),
    [
      "Granted-credential use at 14:29 UTC. This is Ada Lovelace (`discord/G1/U-ASKER`)'s act, run with ada's credential.",
      DISCLOSURE,
    ].join("\n"),
    "the room's disclosure notice",
  );
}

console.log("4. the leak lint:");

const SENTINELS = {
  guid: "00000000-0000-4000-8000-000000000018",
  instant: "2026-03-21T04:19:45.132Z",
  minted: "grant__9000000000000000002_notion__notion_fetch_notion_pag",
  snowflake: "9000000000000000002",
} as const;

const LEAK_PATTERNS = GRANT_ID_LEAK_PATTERNS;

const leaky: CredentialGrantAskRow = {
  ...ask,
  createdAt: SENTINELS.instant,
  expiresAt: SENTINELS.instant,
  id: SENTINELS.guid,
  ownerNativeId: SENTINELS.snowflake,
  ownerPrincipalId: `discord/${SENTINELS.snowflake}/${SENTINELS.snowflake}`,
  ownerSlug: SENTINELS.snowflake,
  requesterPrincipalId: `discord/${SENTINELS.snowflake}/${SENTINELS.snowflake}`,
  resource: `Quarterly report — notion-fetch({tool:${SENTINELS.minted}})`,
  scopeKey: SENTINELS.guid,
  toolName: SENTINELS.minted,
};

const leakyGrant: Pick<CredentialGrantRow, "connector" | "mcpTool" | "expiresAt" | "mode"> = { ...grant, expiresAt: SENTINELS.instant };

const leakyRow: CredentialGrantRow = {
  askId: SENTINELS.guid,
  connector: "notion",
  createdAt: SENTINELS.instant,
  expiresAt: SENTINELS.instant,
  frozenArgs: { id: "quarterly-report" },
  id: SENTINELS.guid,
  mcpTool: "notion-fetch",
  mode: "session",
  ownerPrincipalId: `discord/${SENTINELS.snowflake}/${SENTINELS.snowflake}`,
  ownerSlug: SENTINELS.snowflake,
  purpose: "summarise the quarter for the team",
  requesterPrincipalId: "discord/G1/U-ASKER",
  resource: `Quarterly report — notion-fetch({tool:${SENTINELS.minted}})`,
  scopeKey: SENTINELS.guid,
  status: "active",
  tier: "read",
  toolName: SENTINELS.minted,
  verb: "notion_fetch",
};

function brokerLine(row: CredentialGrantRow): string {
  return credentialGrantDisclosureLine(row, NOW);
}
const GRANT_REFUSAL_REASONS = [
  "revoked",
  "expired",
  "burned",
  "out_of_scope",
  "no_lent_tool",
  "no_transport",
  "owner_unresolvable",
  "unverified_requester",
  "unattended_wake",
  "halted",
  "connector_delisted",
] as const satisfies readonly CredentialGrantRefusal[];
type MissingRefusal = Exclude<CredentialGrantRefusal, (typeof GRANT_REFUSAL_REASONS)[number]>;
const noRefusalMissing: MissingRefusal extends never ? true : MissingRefusal = true;
ok(noRefusalMissing === true, "🔴 the leak lint drives EVERY spend-time refusal arm — checked by the compiler, not by this line");

const leakyMountRow: CredentialGrantRow = { ...leakyRow, inputSchema: { properties: { id: { const: "quarterly-report", type: "string" } }, type: "object" } };

const REFUSALS: readonly GrantMintRefusal[] = [
  "no_domain_grant",
  "unverified_requester",
  "illegal_owner_handle",
  "unresolvable_owner",
  "grant_already_live",
  "ask_already_pending",
  "write_verb_out_of_slice",
  "illegal_tool_name",
  "illegal_connector_id",
];

const rendered: readonly { readonly what: string; readonly text: string }[] = [
  { text: grantCardText(leaky, `discord/${SENTINELS.snowflake}`, undefined, `#${SENTINELS.snowflake}`), what: "the card" },
  { text: grantCardText(leaky, "Ada", { seatLabel: "Atlas" }, undefined), what: "the worker-raised card" },
  { text: grantCardActions(leaky).map((a) => a.label).join("\n"), what: "the button labels" },
  { text: grantApprovedClickText(leakyGrant, NOW), what: "the approval confirmation" },
  { text: grantConsentPromptText(leaky, "https://example.invalid/connect"), what: "the consent detour" },
  { text: approvedGrantCardText(leaky, { expiresAt: SENTINELS.instant, mode: "session" }, NOW), what: "the approved card" },
  { text: declinedGrantCardText(leaky), what: "the declined card" },
  { text: expiredGrantCardText(leaky, true), what: "the expired card (requester told)" },
  { text: expiredGrantCardText(leaky, false), what: "the expired card (requester not told)" },
  { text: refusedGrantCardText(leaky, "tool_absent"), what: "the refused card (tool absent)" },
  { text: refusedGrantCardText(leaky, "frozen_args_unknown"), what: "the refused card (arguments unknown)" },
  { text: refusedGrantCardText({ ...leaky, mcpTool: undefined }, "tool_absent"), what: "the refused card (legacy row)" },
  ...(["consent_required", "catalogue_unreachable", "tool_absent", "frozen_args_unknown", "owner_unresolvable", "not_pending_or_expired", "mint_refused"] as const).flatMap((reason) =>
    [true, false].map((prompted) => ({ text: grantApproveFailureText(reason, prompted), what: `the approve failure "${reason}" (prompted=${String(prompted)})` })),
  ),
  ...REFUSALS.map((reason) => ({
    text: credentialGrantRefusalNote("notion", reason, {
      audience: "seat" as const,
      conversationLabel: `#${SENTINELS.snowflake}`,
      expiresAt: SENTINELS.instant,
      mcpTool: "notion-fetch",
      nowMs: NOW,
      ownerLabel: SENTINELS.snowflake,
    }),
    what: `the mint refusal "${reason}"`,
  })),
  ...REFUSALS.map((reason) => ({ text: grantMintRefusalMessage("notion", reason), what: `the bare mint refusal "${reason}"` })),
  { text: credentialGrantRefusalNote("notion", "owner_unreachable"), what: "the unreachable-owner refusal" },
  ...(["once", "session", "standing"] as const).map((mode) => ({
    text: grantResolutionText(leaky, { askedMode: "once", grant: { ...leakyRow, mode }, kind: "approved" }, NOW),
    what: `the room's resolution notice (approved, ${mode})`,
  })),
  {
    text: grantResolutionText(leaky, { askedMode: "once", grant: { ...leakyRow, toolName: undefined }, kind: "approved" }, NOW),
    what: "the room's resolution notice (approved, nothing mounts)",
  },
  {
    text: grantResolutionText(leaky, { askedMode: "session", grant: { ...leakyRow, mode: "standing" }, kind: "approved" }, NOW),
    what: "the room's resolution notice (approved wider than asked)",
  },
  { text: grantResolutionText(leaky, { kind: "declined" }, NOW), what: "the room's resolution notice (declined)" },
  { text: grantResolutionText(leaky, { kind: "expired" }, NOW), what: "the room's resolution notice (expired)" },
  ...(["tool_absent", "frozen_args_unknown"] as const).map((gate) => ({
    text: grantResolutionText(leaky, { gate, kind: "refused" }, NOW),
    what: `the room's resolution notice (refused, ${gate})`,
  })),
  ...(["once", "session", "standing"] as const).map((mode) => ({
    text: grantOwnerNoticeText({ ...leakyRow, mode }, undefined, NOW),
    what: `the owner's first-use DM (${mode})`,
  })),
  { text: grantOwnerNoticeText(leakyRow, `discord/${SENTINELS.snowflake}`, NOW), what: "the owner's first-use DM (id-shaped requester label)" },
  {
    text: grantRoomNoticeText(brokerLine(leakyRow), leakyRow, SENTINELS.instant),
    what: "the room's disclosure notice",
  },
  {
    text: grantRoomNoticeText(brokerLine(leakyRow), leakyRow, SENTINELS.instant, `discord/${SENTINELS.snowflake}`),
    what: "the room's disclosure notice (id-shaped requester label)",
  },
  { text: brokerLine(leakyRow), what: "the broker's disclosure line" },
  ...GRANT_REFUSAL_REASONS.map((reason) => ({
    text: credentialGrantRefusalMessage(leakyRow, reason),
    what: `the broker's spend-time refusal "${reason}"`,
  })),
  ...GRANT_REFUSAL_REASONS.map((reason) => ({
    text: credentialGrantRefusalMessage({ ...leakyRow, mcpTool: undefined }, reason),
    what: `the broker's spend-time refusal "${reason}" (legacy row, no mcpTool)`,
  })),
  {
    text: descriptionOf(grantToolEntry(leakyMountRow, NOW)),
    what: "the mounted tool description",
  },
  {
    text: descriptionOf(grantToolEntry({ ...leakyMountRow, frozenArgs: undefined, mode: "once" }, NOW)),
    what: "the mounted tool description (one-shot, no frozen arguments)",
  },
  {
    text: descriptionOf(grantToolEntry({ ...leakyMountRow, mcpTool: "notion-search" }, NOW)),
    what: "the mounted tool description (unreviewed vendor tool)",
  },
];

ok(rendered.length >= 30, `the lint drives ${String(rendered.length)} rendered strings — the enumeration is the claim`);
for (const { what, text } of rendered) {
  for (const { name, re } of LEAK_PATTERNS) {
    ok(!re.test(text), `🔴 ${what} carries ${name}`);
  }
  ok(text.trim().length > 0, `${what} renders something`);
}

console.log("5. the negative controls:");
{
  const pageId = "00000000-0000-4000-8000-000000000019";
  const card = grantCardText({ ...ask, frozenArgs: { page_id: pageId } }, "Ada", undefined, "#proj-chat");
  ok(card.includes(pageId), "🔴 a uuid a REQUESTER pinned still renders in full — the owner is the review of the reach, and hiding a value is the worse defect");
  ok(card.includes("summarise the quarter"), "…and the model-authored purpose still renders, so the owner reads what was actually asked for");

  const old = [
    "That conversation can now run `grant__9000000000000000002_notion__notion_fetch_notion_pag` on `Notion page read — notion-fetch({})`",
    "until 2026-03-21T04:19:45.132Z",
    "discord/9000000000000000003 asks to use your notion credential",
    "grant `00000000-0000-4000-8000-000000000018`",
  ];
  for (const line of old) {
    ok(
      LEAK_PATTERNS.some(({ re }) => re.test(line)),
      `NEGATIVE CONTROL: the lint catches the copy it replaced — ${line.slice(0, 40)}`,
    );
  }
  ok(!LEAK_PATTERNS.some(({ re }) => re.test("read a Notion page for the next 12 hours (until 04:19 UTC)")), "…and does NOT fire on ordinary product copy");

  const disclosure = grantRoomNoticeText(brokerLine(leakyRow), leakyRow, SENTINELS.instant);
  ok(disclosure.includes("`discord/G1/U-ASKER`"), "🔴 the room's disclosure notice still names the requester's PRINCIPAL KEY — the audit join, deliberately exempt from the lint");
  ok(grantOwnerNoticeText(leakyRow, undefined, NOW).includes("`discord/G1/U-ASKER`"), "…and so does the owner's first-use DM, for the same reason");

  const line = brokerLine(leakyRow);
  ok(line.startsWith("acting as "), "the broker's line still leads with the §8.2 `acting as` marker — the room's one spelling of 'this ran on somebody's credential'");
  ok(line.includes("Notion account"), "…and names the ACCOUNT that paid, by the vendor's own name");
  ok(line.includes("read a Notion page"), "…and what was done, in the reviewed phrase rather than the `verb` column");
  ok(line.includes("for the next 12 hours (until 04:19 UTC)"), "…and how long is left, as a span and a clock time rather than the ISO column");
  ok(line.includes('The reason given was "summarise the quarter for the team"'), "…and the requester's own reason, as quoted data");
  ok(!line.includes("notion_fetch") && !line.includes("Quarterly report — notion-fetch("), "🔴 NEGATIVE CONTROL: neither the `verb` nor the whole `resource` column survives — those are the two shapes the rewrite removed");

  ok(line.includes('read a Notion page — "Quarterly report"'), "🔴 the line names the TARGET, not only the action — a witness who cannot tell WHICH page is not witnessing");
  ok(
    credentialGrantDisclosureLine({ ...leakyRow, resource: grantBorrowResourceLabel("The launch brief", "notion-fetch", { id: "x" }) }, NOW).includes('— "The launch brief"'),
    "…and it is a function of the row's own column, not a fixed phrase",
  );
  ok(
    !credentialGrantDisclosureLine({ ...leakyRow, mcpTool: undefined }, NOW).includes(" — \""),
    "…and a row with no recoverable label names no target rather than falling back to the raw column",
  );

  const unreviewed = credentialGrantDisclosureLine({ ...leakyRow, mcpTool: "notion-search" }, NOW);
  ok(unreviewed.includes("read one thing in Notion"), "an unreviewed (connector, tool) pair falls to the generic floor rather than printing the vendor's id");
  ok(unreviewed.includes("not one this deployment has a reviewed description for"), "…and the line SAYS the description is generic, so the room does not read the floor as a narrow act");
  ok(!line.includes("not one this deployment has a reviewed description for"), "NEGATIVE CONTROL: the reviewed pair carries no such caution — the marker is a function of the pair, not boilerplate");

  {
    const revoked = credentialGrantRefusalMessage(leakyRow, "revoked");
    ok(revoked.startsWith("Refused:"), "the spend-time refusal still leads with the verdict, so the model cannot read it as output");
    ok(revoked.includes("read a Notion page"), "…and says WHAT the grant was for, in the reviewed phrase rather than the `verb` column");
    ok(revoked.includes('— "Quarterly report"'), "…and WHICH thing, recovered from the requester's own label and quoted as their data");
    ok(revoked.includes("Do not retry"), "…and still tells the model not to re-plan around a mystery, which is the whole reason this copy exists");
    ok(
      !revoked.includes("notion_fetch") && !revoked.includes("notion-fetch("),
      "🔴 NEGATIVE CONTROL: neither the `verb` column nor the CALL half of `resource` survives — the two shapes a relaying model used to put in a room",
    );
    const sentences = GRANT_REFUSAL_REASONS.map((r) => credentialGrantRefusalMessage(leakyRow, r));
    ok(new Set(sentences).size === GRANT_REFUSAL_REASONS.length, "…and no two refusal names share a sentence after the rewrite");

    const mounted = descriptionOf(grantToolEntry(leakyMountRow, NOW));
    ok(mounted.includes("Notion account"), "the mounted description still names WHOSE account the call spends, by the vendor's own name");
    ok(mounted.includes("read a Notion page"), "…and what the tool does");
    ok(mounted.includes('— "Quarterly report"'), "…and which thing, so a tool list of several grants is still tellable apart");
    ok(mounted.includes("for the next 12 hours (until 04:19 UTC)"), "…and how long is left, as a span and a clock rather than the ISO column");
    ok(mounted.includes("FIXED by the grant"), "…and that the frozen arguments are fixed, which is the instruction the schema alone does not give");
    ok(
      !mounted.includes(SENTINELS.instant) && !mounted.includes("notion-fetch("),
      "🔴 NEGATIVE CONTROL: the ISO instant and the code-shaped column are both gone from the string that sits in the model's own tool list",
    );
  }

  const OFFERS_REVOCATION = /(?:you|they)\s+(?:can|may|could|should)\s+(?:revoke|end)\b|unless you revoke|revoke it first|send me a direct message and ask/iu;

  const duplicateFacts = { conversationLabel: "#proj-chat", connector: "notion", expiresAt: SENTINELS.instant, mcpTool: "notion-fetch", nowMs: NOW, ownerLabel: "Ada" };
  ok(
    OFFERS_REVOCATION.test(grantDuplicateRefusalText("owner", duplicateFacts)),
    "🔴 the duplicate refusal OFFERS the end to the OWNER — the route exists now, and they are the one principal it admits",
  );
  ok(
    !OFFERS_REVOCATION.test(grantDuplicateRefusalText("seat", duplicateFacts)),
    "🔴 …and offers it to the REQUESTER never: the verb reaches the caller's OWN grants only, so the same words would be a control they cannot take",
  );
  ok(
    grantDuplicateRefusalText("seat", duplicateFacts).includes("Only Ada can end it early"),
    "…and the seat arm NAMES who can, rather than staying silent about the control",
  );
  ok(
    grantDuplicateRefusalText("owner", duplicateFacts).includes("send me a direct message"),
    "…and the owner arm names a DM, never \"here\": `revoke_credential_grant` refuses every non-DM conversation",
  );

  for (const mode of ["session", "standing"] as const) {
    const dm = grantOwnerNoticeText({ ...leakyRow, mode }, undefined, NOW);
    ok(dm.includes("Tell me here to end it and I will end it now."), `the owner's first-use DM names the route that ends it (${mode})`);
    ok(dm.includes("It stays live for the next"), `…beside the rendered expiry phrase, never the raw ISO column (${mode})`);
    ok(!dm.includes("There is no way to revoke it yet"), `…and no longer says the control is absent, which OPE-1637 made false (${mode})`);
  }
  const onceDm = grantOwnerNoticeText({ ...leakyRow, mode: "once" }, undefined, NOW);
  ok(!onceDm.includes("Tell me here to end it"), "…and a ONCE grant offers nothing to end: its first call already spent it");
  ok(!OFFERS_REVOCATION.test(onceDm), "…and offers it in no other words either — a spent grant has nothing left to revoke");

  ok(OFFERS_REVOCATION.test("It stays live until then unless you revoke it."), "NEGATIVE CONTROL: the matcher catches the promise OPE-1592 removed");
  ok(OFFERS_REVOCATION.test("The owner can revoke it first if they want to be asked again."), "…and the duplicate refusal's old sentence too");
  ok(!OFFERS_REVOCATION.test("Only Ada can end it early, so a new request stays refused."), "NEGATIVE CONTROL: …and does NOT fire on a sentence that names the control while denying it");
  for (const audience of ["owner", "seat"] as const) {
    const dup = grantDuplicateRefusalText(audience, { conversationLabel: "#proj-chat", connector: "notion", expiresAt: SESSION_EXPIRY, mcpTool: "notion-fetch", nowMs: NOW, ownerLabel: "Ada" });
    ok(dup.includes("while this one is live"), `the duplicate refusal (${audience}) is bounded by the grant being LIVE, not by its expiry`);
    ok(!dup.includes("stays refused until it expires"), `…and never claims the refusal lasts until the expiry (${audience})`);
  }
}

console.log(`\ncredential-grant-copy: ${String(n)} assertions passed.`);
