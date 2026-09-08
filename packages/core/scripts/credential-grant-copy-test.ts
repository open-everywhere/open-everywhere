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
  grantExpiryPhrase,
  grantRequesterPhrase,
} from "../agent/access/credential-grant-copy.js";
import { credentialGrantRefusalNote } from "../agent/access/credential-grant-ask.js";
import { credentialGrantMintVerdict, grantMintRefusalMessage, type GrantMintInput, type GrantMintRefusal } from "../agent/access/credential-grant.js";
import { grantBorrowResourceLabel, grantJsonColumn, grantJsonFromColumn, grantResourceTargetLabel } from "../agent/operational/credential-grant-rows.js";
import type { CredentialGrantAskRow, CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";

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
    grantRequesterPhrase("discord/1300000000000000103"),
    "Someone this deployment cannot name",
    "🔴 an ID-SHAPED label is DROPPED, not printed — the guard is structural, not a convention at one caller",
  );
  eq(grantConversationPhrase("#300000000000000104"), "that conversation", "…and the same guard covers the room label a scope resolver answered with");
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
      "• *Approve for 30 days* — a standing grant, clamped to a fixed 30-day ceiling.",
      "• *Decline* — nothing is granted.",
      "",
      "A button is the only thing that can answer this. If the buttons are missing, or a tap seems to do nothing, nothing has been granted — the request then lapses on its own and they can raise a fresh one.",
      "Approving lets the #proj-chat conversation read a Notion page with your account — the pinned values above, and nothing else in Notion. No other conversation gets it.",
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

  const pinnedTail = grantCardText(ask, "Ada Lovelace", undefined, "#proj-chat").split("\n").at(-1);
  const openTail = grantCardText({ ...ask, frozenArgs: {}, resource: "Quarterly report — notion-fetch({})" }, "Ada Lovelace", undefined, "#proj-chat").split("\n").at(-1);
  eq(
    pinnedTail,
    "Approving lets the #proj-chat conversation read a Notion page with your account — the pinned values above, and nothing else in Notion. No other conversation gets it.",
    "a PINNED grant's last line bounds it to the pinned values",
  );
  eq(
    openTail,
    "Approving lets the #proj-chat conversation read a Notion page with your account, choosing for itself which one, every time. Nothing is pinned, so this reaches whatever that tool can read in your Notion account. No other conversation gets it.",
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

  eq(
    credentialGrantRefusalNote("notion", "grant_already_live", {
      audience: "owner",
      conversationLabel: "#proj-chat",
      expiresAt: SESSION_EXPIRY,
      mcpTool: "notion-fetch",
      nowMs: NOW,
      ownerLabel: "Ada Lovelace",
    }),
    "The #proj-chat conversation already has this grant from you (read a Notion page, for the next 12 hours (until 21:29 UTC)). Nothing new was requested — use the grant that is already there. Revoke it first if you want to be asked again.",
    "the duplicate refusal, OWNER-facing — the person who asked IS the owner, so it says 'you'",
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
    "That conversation already has this grant from Ada Lovelace (read a Notion page, for the next 12 hours (until 21:29 UTC)). Nothing new was requested — use the grant that is already there. The owner can revoke it first if they want to be asked again.",
    "the duplicate refusal, SEAT-facing — a third party reads the owner's name, never 'you'",
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
}

console.log("4. the leak lint:");

const SENTINELS = {
  guid: "00000000-0000-4000-8000-000000000018",
  instant: "2026-03-21T04:19:45.132Z",
  minted: "grant__300000000000000104_notion__notion_fetch_notion_pag",
  snowflake: "300000000000000104",
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
    "That conversation can now run `grant__300000000000000104_notion__notion_fetch_notion_pag` on `Notion page read — notion-fetch({})`",
    "until 2026-03-21T04:19:45.132Z",
    "discord/1300000000000000103 asks to use your notion credential",
    "grant `00000000-0000-4000-8000-000000000018`",
  ];
  for (const line of old) {
    ok(
      LEAK_PATTERNS.some(({ re }) => re.test(line)),
      `NEGATIVE CONTROL: the lint catches the copy it replaced — ${line.slice(0, 40)}`,
    );
  }
  ok(!LEAK_PATTERNS.some(({ re }) => re.test("read a Notion page for the next 12 hours (until 04:19 UTC)")), "…and does NOT fire on ordinary product copy");
}

console.log(`\ncredential-grant-copy: ${String(n)} assertions passed.`);
