// proves: AP-MOD-core-access-credential-grant-ask, AP-MOD-core-access-credential-grant-click
// proves: AP-MOD-core-access-credential-grant-flow
// proves: grant.mount_refused

import { __setTestValveForTest } from "../agent/testing/test-valves.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-ask-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;
__setTestValveForTest("egress-spoof", false);

import { GRANT_CARD_CLICK_ACTION, handleGrantCardClick, resolveGrantCardClick, type GrantClickFailureReason } from "../agent/access/credential-grant-click.js";
import { grantCardActionId, grantCardActions, OE_GRANT_ACTION_PREFIX, parseGrantCardActionId } from "../agent/access/credential-grant-card.js";
import { resolveGrantOwner } from "../agent/access/credential-grant-ask.js";
import { askForCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { grantDomainScopeKey } from "../agent/access/credential-grant-scope.js";
import { bindFrom } from "../agent/identity/binding.js";
import { supervisorGrainFor } from "../agent/channels/unified-supervisor.js";
import { standingSeatDomainFor } from "../agent/memory/domain.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";
import { setRegisteredConnectorCredentials, oauthConnectorHome } from "../agent/access/connector-credentials.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { registerUserAuthFlow } from "../agent/connections/user-auth-flow.js";
import { OE_OWN_ACCOUNT_ASK_ATTR, renderOwnAccountStamp } from "../agent/connections/own-account-carriage.js";
import { namedOwnAccountVendor } from "../agent/connections/own-account-ask.js";
import { ownAccountVendorFor } from "../agent/connections/own-account-vendors.js";
import { GRANTS_SECTION } from "../agent/instructions/seat-prompt.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import { fakeMcpServer } from "./_fake-mcp-server.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";
import type { ReplyTarget } from "../agent/channels/reply-post.js";
import { _resetAccountDisplayNamesForTest, registerAccountDisplayName } from "../agent/identity/account-display-name.js";
import { getOperationalStore, registerOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import type { OperationalStore } from "../agent/operational/store.js";
import type { CredentialGrantAskRow } from "../agent/operational/credential-grant-rows.js";
import { readAudit } from "../agent/audit/audit.js";
import { deploymentOrg } from "../agent/identity/binding.js";
import { allowedOnLeanSeat } from "../agent/access/lean-seat.js";
import { allowedOnWorkerSeat } from "../agent/access/worker-seat.js";
import { WORKER_ONLY_TOOLS_STANDING } from "../agent/access/worker-capability-index.generated.js";
import { noteEnvelopeWrapThisTurn, envelopeWrappedThisTurn } from "../agent/memory/turn-provenance.js";
import { credentialGrantConnectors } from "../agent/access/credential-grant.js";
import { classifyConnectorOpTier } from "../agent/access/consequence.js";
import {
  _grantMountAuditSettled,
  _resetGrantMountAuditForTest,
  defaultGrantTool,
  requestCredentialGrantEntry,
  requestCredentialGrantMount,
} from "../agent/tools/request_credential_grant.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { domainKeyOf, resolvePartition } from "../agent/memory/partition.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";
import { adoptDelegatedAuthority } from "../agent/identity/delegated-binding.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = deploymentOrg();
const WS = "T1";
const OWNER = `slack/${WS}/U-owner`;
const REQ = `slack/${WS}/U-req`;
const ROOM: ReplyTarget = { channelId: "C-ROOM", platform: "slack", threadTs: "1769361952.935000" };
const stamps = { org: ORG, platform: "slack", surface: "slack/T1/C-ROOM", workspace: WS };

_resetAccountDisplayNamesForTest();
registerAccountDisplayName("slack", async (nativeId) => (nativeId === "U-owner" ? { handle: "rowan", name: "Rowan Hale" } : undefined));

const posted: { text: string; target: ReplyTarget }[] = [];
const dmed: DirectMessageRequest[] = [];
registerPostArm({
  deliverDirectMessage: async (input: DirectMessageRequest) => {
    dmed.push(input);
    return { messageId: `dm-${dmed.length}`, surfaceId: "D-owner" };
  },
  displayNameCapable: true,
  dispatchReply: async (target: ReplyTarget, text: string) => {
    posted.push({ target, text });
    return `ts-${posted.length}`;
  },
  platform: "slack",
  resolveTarget: () => null,
});

const store = getOperationalStore();
let clock = Date.parse("2026-01-29T18:22:00.000Z");

const MCP_URL = "https://mcp.notion.com/mcp";
const VENDOR_TOOL = "notion-fetch";
const VENDOR_SCHEMA = {
  properties: { id: { description: "the page id", type: "string" }, page_size: { type: "number" } },
  required: ["id"],
  type: "object",
} as const;

setRegisteredConnectorCredentials([
  {
    allows: ["user-oauth"],
    connector: "notion",
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: oauthConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
  },
]);
selectConnectorTransport({ connector: "notion", directUrl: MCP_URL, provider: "notion" });
const USER_AUTH_FLOW = {
  environmentClaim: async () => "test",
  isUserAuthRequired: () => false,
  mintServiceToken: async () => ({ token: "SERVICE" }),
  mintUserToken: async () => ({ token: "OWNER-TOKEN" }),
  startAuthorization: async () => ({ url: "https://connect.example/consent" }),
};
registerUserAuthFlow(USER_AUTH_FLOW);
const vendor = fakeMcpServer({ tools: [{ inputSchema: VENDOR_SCHEMA, name: VENDOR_TOOL }] });

async function raise(
  over: Partial<{
    requester: string | undefined;
    resource: string;
    target: string | undefined;
    purpose: string;
    scope: string;
    domain: string;
    mode: "once" | "session" | "standing";
    now: number;
    tool: string;
    frozenArgs: Record<string, unknown>;
  }> = {},
): Promise<{ sent: boolean; askId?: string; reason?: string; toolName?: string }> {
  const outcome = await askForCredentialGrant({
    connector: "notion",
    domainGrantsConnector: true,
    explicit: false,
    frozenArgs: over.frozenArgs ?? { id: "abc123" },
    mcpTool: over.tool ?? "notion-fetch",
    nowMs: over.now ?? clock,
    org: ORG,
    ownerHandle: "Rowan Hale",
    ownerNativeId: "U-owner",
    ownerPlatform: "slack",
    ownerPrincipalId: OWNER,
    platform: "slack",
    purpose: over.purpose ?? "draft the Q3 summary",
    requestedMode: over.mode ?? "once",
    requesterLabel: "Requesting Person",
    requesterPrincipalId: "requester" in over ? over.requester : REQ,
    ...("target" in over ? (over.target === undefined ? {} : { requesterTarget: over.target }) : { requesterTarget: JSON.stringify(ROOM) }),
    scopeKey: over.scope ?? "sess-chat-1",
    ...(over.domain === undefined ? {} : { domainScopeKey: over.domain }),
    surface: stamps.surface,
    targetLabel: over.resource ?? "Launch page",
    workspace: WS,
  });
  return outcome.sent ? { askId: outcome.askId, sent: true, toolName: outcome.toolName } : { reason: outcome.reason, sent: false };
}

console.log("1. the owner is NAMED, never searched:");
{
  const byKey = await resolveGrantOwner(OWNER, "slack", WS);
  ok(!("refusal" in byKey), "a full principal key resolves");
  if (!("refusal" in byKey)) {
    eq(byKey.principalId, OWNER, "…to itself — the key is never reinterpreted against the caller's surface");
    eq(byKey.nativeId, "U-owner", "…and the native id is the platform's own");
    eq(byKey.handle, "Rowan Hale (@rowan)", "…with the display handle resolved through the account-display-name plane");
  }

  const byBare = await resolveGrantOwner("U0OWNER01", "slack", WS);
  ok(!("refusal" in byBare) && byBare.principalId === `slack/${WS}/U0OWNER01`, "a BARE id on the caller's own surface composes the same key — one composer, two spellings");

  const byMention = await resolveGrantOwner("<@U0OWNER01>", "slack", WS);
  ok(!("refusal" in byMention) && byMention.principalId === `slack/${WS}/U0OWNER01`, "a surface's MENTION rendering is peeled — it is what a person literally types");

  const slackIdInDiscord = await resolveGrantOwner("U0EXOWNER", "discord", "");
  ok("refusal" in slackIdInDiscord, "🔴 OPE-2063: a Slack member id named bare in a DISCORD room refuses");
  if ("refusal" in slackIdInDiscord) {
    ok(slackIdInDiscord.refusal.includes('"U0EXOWNER" is not a Discord user id'), `…and the note names the id and the platform (got: ${slackIdInDiscord.refusal})`);
    ok(slackIdInDiscord.refusal.includes("name the owner as they appear in this room"), "…and tells the seat what to do instead");
  }
  const mentionedSlackIdInDiscord = await resolveGrantOwner("<@U0EXOWNER>", "discord", "");
  ok("refusal" in mentionedSlackIdInDiscord, "…and so does the same id in a mention rendering");
  const snowflakeInSlack = await resolveGrantOwner("300000000000000104", "slack", WS);
  ok("refusal" in snowflakeInSlack, "…and a Discord snowflake named bare in a SLACK room refuses too");
  if ("refusal" in snowflakeInSlack) {
    ok(!snowflakeInSlack.refusal.includes("300000000000000104"), "…without printing the snowflake — refusal copy never carries a bare 17-20 digit id");
  }
  const snowflakeInDiscord = await resolveGrantOwner("300000000000000104", "discord", "");
  ok(
    !("refusal" in snowflakeInDiscord) && snowflakeInDiscord.principalId === "discord/300000000000000104",
    "a snowflake named bare in a Discord room resolves to its discord key",
  );
  const fullKeyInDiscord = await resolveGrantOwner(OWNER, "discord", "");
  ok(!("refusal" in fullKeyInDiscord) && fullKeyInDiscord.principalId === OWNER, "a FULL key passes through unchanged, whatever room it is named in");
  const discordKeyInDiscord = await resolveGrantOwner("discord/300000000000000104", "discord", "");
  ok(!("refusal" in discordKeyInDiscord) && discordKeyInDiscord.principalId === "discord/300000000000000104", "…and so does a full discord key");
  const unshapedPlatform = await resolveGrantOwner("octocat", "github", "");
  ok(!("refusal" in unshapedPlatform), "a platform with no defined id shape keeps today's behaviour");

  const bad = await resolveGrantOwner("slack/U-owner", "slack", WS);
  ok("refusal" in bad, "a MALFORMED key refuses — a fuzzy match on whose credential gets spent must never be one character away");
  const empty = await resolveGrantOwner("   ", "slack", WS);
  ok("refusal" in empty, "…and so does an empty name");

  const noTenant = await resolveGrantOwner("U0OWNER01", "slack", "");
  ok("refusal" in noTenant, "a bare id with no nameable workspace refuses rather than composing an unmatched key");
}

console.log("2. one live ask per (requester, owner, verb, resource):");
let firstAskId = "";
{
  const first = await raise();
  ok(first.sent, "the first ask is sent");
  firstAskId = first.askId ?? "";
  eq(dmed.length, 1, "…and the owner got exactly one card");

  const stamped = await store.getCredentialGrantAsk(ORG, firstAskId);
  eq(stamped?.cardSurfaceId, "D-owner", "the ask row pins the DM surface the card landed in");
  eq(stamped?.cardMessageId, "dm-1", "…and the message id the delivery named — together they are the sweep's only way to find the card");

  const second = await raise();
  eq(second.reason, "ask_already_pending", "a SECOND ask for the same tuple refuses by name");
  eq(dmed.length, 1, "…and no second card was sent — this is the anti-nag control, so the DM count is the assertion that matters");

  const other = await raise({ requester: `slack/${WS}/U-other` });
  ok(other.sent, "a DIFFERENT requester asking the same owner for the same page is NOT blocked");
  eq(dmed.length, 2, "…and the owner got a second card for it");

  const otherResource = await raise({ resource: "notion:page/def456" });
  ok(otherResource.sent, "the same requester asking for a DIFFERENT resource is NOT blocked");

  const before = clock;
  clock += 31 * 60 * 1000;
  const afterTtl = await raise();
  ok(afterTtl.sent, "once the first ask's TTL has passed, the same tuple can be asked again — expiry is in the store predicate, not in a sweep");
  clock = before;
  if (afterTtl.askId) await store.decideCredentialGrantAsk(ORG, afterTtl.askId, ["pending"], "declined", new Date(clock).toISOString());
}

console.log("2b. a pending ask's mounted name is already claimed (OPE-1199):");
{
  const SCOPE = "sess-name-1";
  const nowIso = (): string => new Date(clock).toISOString();

  const a = await raise({ frozenArgs: { id: "page-a" }, scope: SCOPE });
  ok(a.sent, "the first ask is sent");
  const b = await raise({ frozenArgs: { id: "page-b" }, scope: SCOPE });
  ok(b.sent, "…and a second ask, same tool and same label but frozen to a DIFFERENT page, is admitted — two decisions, not a nag");
  ok(a.toolName !== undefined && b.toolName !== undefined, "both asks pinned a mounted tool name");
  ok(a.toolName !== b.toolName, "🔴 the two pinned names DIFFER — a PENDING ask holds its name, so the second ask spells a distinct one");

  const pending = await store.pendingCredentialGrantAsksForScope(ORG, SCOPE, nowIso());
  eq([...pending.map((r) => r.toolName)].sort(), [a.toolName, b.toolName].sort(), "the scope read returns exactly the two pending asks, with their pinned names");

  eq((await store.pendingCredentialGrantAsksForScope(ORG, "sess-name-2", nowIso())).length, 0, "another chat's read returns nothing — the claim is scoped to the conversation");
  const elsewhere = await raise({ frozenArgs: { id: "page-a" }, requester: `slack/${WS}/U-third`, scope: "sess-name-2" });
  eq(elsewhere.toolName, a.toolName, "…so the SAME borrow in ANOTHER chat spells the SAME bare name: a mounted name is claimed per chat, never per deployment");

  for (const askId of [a.askId, b.askId]) {
    if (askId !== undefined) await store.decideCredentialGrantAsk(ORG, askId, ["pending"], "declined", nowIso());
  }
  eq((await store.pendingCredentialGrantAsksForScope(ORG, SCOPE, nowIso())).length, 0, "both asks DECLINED: the scope read is empty again");
  const afterDecline = await raise({ frozenArgs: { id: "page-c" }, scope: SCOPE });
  eq(afterDecline.toolName, a.toolName, "…and the next ask takes the bare name back — a dead ask mounts nothing, so it claims nothing");

  const before = clock;
  clock += 31 * 60 * 1000;
  eq((await store.pendingCredentialGrantAsksForScope(ORG, SCOPE, nowIso())).length, 0, "a LAPSED pending ask reads as gone, with no sweep having run");
  const afterTtl = await raise({ frozenArgs: { id: "page-d" }, scope: SCOPE });
  eq(afterTtl.toolName, a.toolName, "…and its name is free for the next ask");
  clock = before;
}

console.log("3. the action-id grammar:");
{
  for (const answer of ["once", "session", "standing", "decline"] as const) {
    const id = grantCardActionId("ask-uuid-1", answer);
    eq(parseGrantCardActionId(id), { answer, askId: "ask-uuid-1" }, `\`${answer}\` round-trips through the id`);
  }
  eq(parseGrantCardActionId("oe_approval:approve:x"), undefined, "another plane's prefix is not ours");
  eq(parseGrantCardActionId("eve_input:x"), undefined, "eve's own prefix is not ours");
  eq(parseGrantCardActionId(`${OE_GRANT_ACTION_PREFIX}frobnicate:x`), undefined, "an answer outside the closed set is refused — the id is PARSED, never interpreted");
  eq(parseGrantCardActionId(`${OE_GRANT_ACTION_PREFIX}once:`), undefined, "an empty ask id is refused");
  eq(parseGrantCardActionId(undefined), undefined, "an absent id is refused");
  const longest = grantCardActionId("00000000-0000-0000-0000-000000000000", "standing");
  ok(longest.length <= 100, `the longest well-formed id is ${longest.length} characters, inside the 100-character component cap`);

  const actions = grantCardActions({ domainScopeKey: "oe-grant-domain::ask-test", id: "ask-uuid-1", requestedMode: "once" } as never);
  eq(actions.length, 4, "the card carries four buttons");
  eq(grantCardActions({ id: "ask-uuid-1", requestedMode: "once" } as never).length, 3, "🔴 …and THREE on an ask with no domain key, because no tap may name an answer the mint would refuse");
  eq(actions.filter((a) => a.intent === "reject").length, 1, "…and exactly one of them is the reject intent");
  eq(
    actions.map((a) => parseGrantCardActionId(a.id)?.answer),
    ["once", "session", "standing", "decline"],
    "…and every rendered button id parses back to the answer it shows",
  );
}

console.log("4. the click route — only the owner may answer:");
await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => {
  const stranger = await resolveGrantCardClick({
    answer: "once",
    askId: firstAskId,
    clicker: { nativeId: "U-stranger", platform: "slack", tenant: WS },
    nowMs: clock,
    ...stamps,
  });
  eq(stranger.outcome, "not-yours", "a stranger holding the ask id cannot answer it");
  const afterStranger = await store.getCredentialGrantAsk(ORG, firstAskId);
  eq(afterStranger?.status, "pending", "…and the row did not move — the STORE is the oracle, not the returned copy");

  const unknown = await resolveGrantCardClick({
    answer: "once",
    askId: "no-such-ask",
    clicker: { nativeId: "U-owner", platform: "slack", tenant: WS },
    nowMs: clock,
    ...stamps,
  });
  eq(unknown.outcome, "not-yours", "an UNKNOWN ask id gets the same answer a stranger's does — the button is not an oracle");
  eq(unknown.text, stranger.text, "…the same copy, byte for byte");

  const noTenant = await resolveGrantCardClick({
    answer: "once",
    askId: firstAskId,
    clicker: { nativeId: "U-owner", platform: "slack" },
    nowMs: clock,
    ...stamps,
  });
  eq(noTenant.outcome, "not-yours", "a clicker with no nameable workspace fails CLOSED — a bare id would match nobody");

  posted.length = 0;
  const owner = await resolveGrantCardClick({
    answer: "session",
    askId: firstAskId,
    clicker: { nativeId: "U-owner", platform: "slack", tenant: WS },
    nowMs: clock,
    ...stamps,
  });
  eq(owner.outcome, "approved", "the OWNER's tap approves");
  const askRow = await store.getCredentialGrantAsk(ORG, firstAskId);
  eq(askRow?.status, "approved", "…the ask row moved to approved");
  ok(typeof askRow?.grantId === "string", "…and it names the grant it minted");
  const grant = askRow?.grantId ? await store.getCredentialGrant(ORG, askRow.grantId) : null;
  ok(grant !== null, "a credential_grant ROW exists — this is the fact the whole slice is for");
  eq(grant?.status, "active", "…active");
  eq(grant?.mode, "session", "…in the mode the BUTTON carried, not the mode the requester asked for (`once`)");
  eq(grant?.scopeKey, "sess-chat-1", "…scoped to the chat that asked");
  eq(grant?.ownerSlug, "rowan_hale", "…under the owner slug the ASK pinned");
  eq(grant?.toolName, "grant__rowan_hale_notion__notion_fetch_launch_page", "…mounted under the name the ASK pinned, target label and all");
  eq(owner.text.includes("grant__"), false, "…and the owner's confirmation names NO mounted tool — the name is the mint contract, not copy");
  ok(owner.text.includes("read a Notion page"), "…it says what that conversation can now DO");
  ok(/until \d\d:\d\d UTC/u.test(owner.text), "…and when it ends, as a clock time rather than an ISO instant");

  const listed = vendor.seen.find((r) => (r.body?.["method"] as string | undefined) === "tools/list");
  ok(listed !== undefined, "the owner's live connection was read at approve time");
  eq(listed?.authorization, "Bearer OWNER-TOKEN", "…under the OWNER's own token");
  ok(vendor.seen.every((r) => r.redirect === "error"), "…and every request went through the fenced fetch");

  eq(
    grant?.inputSchema,
    {
      properties: { id: { const: "abc123", description: "the page id", type: "string" }, page_size: { type: "number" } },
      required: ["id"],
      type: "object",
    },
    "the snapshot keeps the vendor's schema and PINS the granted argument with const — it is not hidden from the model",
  );

  const twice = await resolveGrantCardClick({
    answer: "once",
    askId: firstAskId,
    clicker: { nativeId: "U-owner", platform: "slack", tenant: WS },
    nowMs: clock,
    ...stamps,
  });
  eq(twice.outcome, "gone", "a SECOND tap on an answered ask loses the CAS");
  const grantsForScope = await store.credentialGrantsForScope(ORG, "sess-chat-1");
  eq(grantsForScope.length, 1, "…and minted no second grant");
});

console.log("5. the answer is posted back into the conversation that asked:");
await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => {
  eq(posted.length, 1, "the approval posted exactly one notice");
  eq(posted[0]?.target, ROOM, "…at the target the ASK pinned, not at anything resolved at click time");
  ok(posted[0]?.text.includes("approved"), "…and it says the grant was approved");
  ok(
    !posted[0]?.text.includes("grant__rowan_hale_notion__notion_fetch_launch_page"),
    "…and it never shows the room the MINTED TOOL NAME",
  );
  ok(
    posted[0]?.text.includes("The next task this conversation hands off can use it."),
    "…it says how the tool is REACHED instead — through the next task the seat delegates, because the tool mounts on the workers (OPE-2023)",
  );

  posted.length = 0;
  const declineAsk = await raise({ resource: "notion:page/ghi789", scope: "sess-chat-2" });
  const declined = await resolveGrantCardClick({
    answer: "decline",
    askId: declineAsk.askId ?? "",
    clicker: { nativeId: "U-owner", platform: "slack", tenant: WS },
    nowMs: clock,
    ...stamps,
  });
  eq(declined.outcome, "declined", "a decline is recorded");
  eq((await store.getCredentialGrantAsk(ORG, declineAsk.askId ?? ""))?.status, "declined", "…the row is terminal");
  eq(posted.length, 1, "…and the room was told");
  ok(posted[0]?.text.includes("declined"), "…that the answer was no");
  ok(!posted[0]?.text.includes("purpose"), "…without a reason: a person's grounds for refusing their own credential are theirs");

  posted.length = 0;
  const untargeted = await raise({ resource: "notion:page/jkl000", scope: "sess-chat-3", target: undefined });
  ok(untargeted.sent, "an ask raised on a surface with no mid-turn post arm still sends the card");
  const untargetedResult = await resolveGrantCardClick({
    answer: "once",
    askId: untargeted.askId ?? "",
    clicker: { nativeId: "U-owner", platform: "slack", tenant: WS },
    nowMs: clock,
    ...stamps,
  });
  eq(untargetedResult.outcome, "approved", "…and it can still be approved");
  eq(posted.length, 0, "…but NOTHING is posted, because nothing recorded where to post it — an honest absence, never a guessed room");
});

console.log("6. the Slack door, and one audit row per tap:");
await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => {
  const notOurs = await handleGrantCardClick({ actions: [{ action_id: "oe_approval:approve:x" }], user: { id: "U-owner" } });
  eq(notOurs, false, "a payload carrying somebody else's action id is NOT ours — the caller forwards it untouched");

  const malformed = await handleGrantCardClick({ actions: [{ action_id: `${OE_GRANT_ACTION_PREFIX}once:x` }] });
  eq(malformed, true, "a payload of OURS with no user is still OURS — a half-understood payload is answered here, never forwarded");

  const doorAsk = await raise({ now: Date.now(), resource: "notion:page/door01", scope: "sess-chat-door" });
  const answers: { channelId: string; userId: string; text: string }[] = [];
  const claimed = await handleGrantCardClick(
    {
      actions: [{ action_id: grantCardActionId(doorAsk.askId ?? "", "once") }],
      channel: { id: "D-owner" },
      team: { id: WS },
      type: "block_actions",
      user: { id: "U-owner" },
    },
    { ephemeral: async (channelId, userId, text) => void answers.push({ channelId, text, userId }) },
  );
  eq(claimed, true, "the Slack door claims its own payload");
  eq((await store.getCredentialGrantAsk(ORG, doorAsk.askId ?? ""))?.status, "approved", "…and the ask really was approved through it");
  eq(answers.length, 1, "…the owner got exactly one private answer");
  eq(answers[0]?.userId, "U-owner", "…addressed to the person who tapped, from the payload's own verified user");
  ok((answers[0]?.text ?? "").includes("Approved"), "…saying what they granted");
  ok(!(answers[0]?.text ?? "").includes("U-req"), "…and it does not name the requester's raw id back at the owner");

  const rows = (await readAudit({ org: ORG, limit: 200 })).filter((r) => r.action === GRANT_CARD_CLICK_ACTION);
  ok(rows.length >= 5, `every tap wrote a click row (${rows.length})`);
  const outcomes = new Set(rows.map((r) => (r.detail as Record<string, unknown>).outcome));
  ok(outcomes.has("approved") && outcomes.has("declined") && outcomes.has("not-yours") && outcomes.has("gone"), "…and the rows carry each outcome by name");
  ok(
    rows.every((r) => !JSON.stringify(r.detail).includes("draft the Q3 summary")),
    "…and no click row carries the model-authored purpose — ids and the outcome only",
  );
});

console.log("6b. a failed tap names its reason on the audit row (OPE-1588):");
{
  const drove: Record<GrantClickFailureReason, boolean> = {
    catalogue_unreachable: false,
    click_threw: false,
    consent_required: false,
    frozen_args_unknown: false,
    mint_refused: false,
    owner_unresolvable: false,
    standing_unavailable: false,
    tool_absent: false,
  };

  const clickRow = async (askId: string, label: string): Promise<Record<string, unknown>> => {
    const rows = (await readAudit({ org: ORG, limit: 500 })).filter(
      (r) => r.action === GRANT_CARD_CLICK_ACTION && (r.detail as Record<string, unknown>).askId === askId,
    );
    eq(rows.length, 1, `${label}: the tap wrote exactly ONE click row`);
    return (rows[0]?.detail ?? {}) as Record<string, unknown>;
  };

  const tap = async (askId: string, clicker: { nativeId: string; platform: string; tenant?: string }): ReturnType<typeof resolveGrantCardClick> =>
    await resolveGrantCardClick({ answer: "once", askId, clicker, nowMs: clock, ...stamps });

  const OWNER_CLICKER = { nativeId: "U-owner", platform: "slack", tenant: WS };

  const failedTap = async (askId: string, reason: GrantClickFailureReason, label: string, run: () => Promise<{ outcome: string; text: string }>): Promise<Record<string, unknown>> => {
    const result = await run();
    eq(result.outcome, "failed", `${label}: the tap resolves to failed`);
    ok(result.text.length > 0, `${label}: …and the owner still gets a sentence`);
    const detail = await clickRow(askId, label);
    eq(detail.outcome, "failed", `${label}: …the row records the same outcome`);
    eq(detail.reason, reason, `🔴 ${label}: …and the row NAMES the reason — the whole of OPE-1588`);
    drove[reason] = true;
    return detail;
  };

  const craftAsk = async (over: Partial<CredentialGrantAskRow> & { readonly id: string }): Promise<string> => {
    await store.addCredentialGrantAsk(ORG, {
      connector: "notion",
      createdAt: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 30 * 60 * 1000).toISOString(),
      frozenArgs: { id: "abc123" },
      mcpTool: VENDOR_TOOL,
      ownerNativeId: "U-owner",
      ownerPlatform: "slack",
      ownerPrincipalId: OWNER,
      ownerSlug: "rowan",
      purpose: "read it for me",
      requestedMode: "once",
      requesterPrincipalId: REQ,
      resource: "Launch page",
      scopeKey: "sess-crafted",
      status: "pending",
      toolName: `grant__rowan_notion__${over.id}`,
      verb: "notion_fetch",
      ...over,
    });
    return over.id;
  };

  {
    const ask = await raise({ frozenArgs: { id: "reason-consent" }, scope: "sess-reason-consent" });
    ok(ask.sent, "consent_required: the ask was raised through the shipped path");
    const dmsBefore = dmed.length;
    registerUserAuthFlow({ ...USER_AUTH_FLOW, hasFreshGrant: async () => false });
    let detail: Record<string, unknown>;
    try {
      detail = await failedTap(ask.askId ?? "", "consent_required", "consent_required", async () =>
        await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => await tap(ask.askId ?? "", OWNER_CLICKER)),
      );
    } finally {
      registerUserAuthFlow(USER_AUTH_FLOW);
    }
    eq(detail.linkDelivered, dmed.length > dmsBefore, "…and `linkDelivered` says what the DM arm actually did");
    eq(detail.linkDelivered, true, "…which on this fixture is: the connect link reached the owner");
    eq((await store.getCredentialGrantAsk(ORG, ask.askId ?? ""))?.status, "pending", "…and the ask stays PENDING, so pressing Approve after connecting still works");
  }

  {
    const DISCORD_OWNER = "discord/U-owner-d";
    const askId = await craftAsk({ id: "ask-consent-nodm", ownerNativeId: "U-owner-d", ownerPlatform: "discord", ownerPrincipalId: DISCORD_OWNER, scopeKey: "sess-reason-consent-nodm" });
    const dmsBefore = dmed.length;
    registerUserAuthFlow({ ...USER_AUTH_FLOW, hasFreshGrant: async () => false });
    let detail: Record<string, unknown>;
    try {
      detail = await failedTap(askId, "consent_required", "consent_required (no DM arm)", async () =>
        await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => await tap(askId, { nativeId: "U-owner-d", platform: "discord" })),
      );
    } finally {
      registerUserAuthFlow(USER_AUTH_FLOW);
    }
    eq(dmed.length, dmsBefore, "no DM went out — this deployment cannot cold-address that owner");
    eq(detail.linkDelivered, false, "🔴 …and the row says so, rather than claiming a link the owner never got");
  }

  {
    const ask = await raise({ frozenArgs: { id: "reason-unreachable" }, scope: "sess-reason-unreachable" });
    ok(ask.sent, "catalogue_unreachable: the ask was raised");
    const dead = fakeMcpServer({ failWithStatus: 503, tools: [{ inputSchema: VENDOR_SCHEMA, name: VENDOR_TOOL }] });
    const detail = await failedTap(ask.askId ?? "", "catalogue_unreachable", "catalogue_unreachable", async () =>
      await withPatchedFetch(dead.fetch as unknown as typeof globalThis.fetch, async () => await tap(ask.askId ?? "", OWNER_CLICKER)),
    );
    eq(detail.linkDelivered, undefined, "…and NO `linkDelivered` — that fact belongs to consent_required alone");
    eq((await store.getCredentialGrantAsk(ORG, ask.askId ?? ""))?.status, "pending", "…and a blip costs a retry, never the owner's decision");
  }

  {
    const ask = await raise({ frozenArgs: { id: "reason-absent" }, scope: "sess-reason-absent", tool: "notion-fetch-absent" });
    ok(ask.sent, "tool_absent: an ask naming a tool the connection does not publish is still ADMITTED at ask time");
    await failedTap(ask.askId ?? "", "tool_absent", "tool_absent", async () =>
      await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => await tap(ask.askId ?? "", OWNER_CLICKER)),
    );
    eq((await store.getCredentialGrantAsk(ORG, ask.askId ?? ""))?.status, "expired", "…and this one CLOSES the ask — the owner said yes and it could not be honoured");
  }

  {
    const ask = await raise({ frozenArgs: { id: "reason-frozen", nope: true }, scope: "sess-reason-frozen" });
    ok(ask.sent, "frozen_args_unknown: the ask was raised");
    await failedTap(ask.askId ?? "", "frozen_args_unknown", "frozen_args_unknown", async () =>
      await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => await tap(ask.askId ?? "", OWNER_CLICKER)),
    );
    eq((await store.getCredentialGrantAsk(ORG, ask.askId ?? ""))?.status, "expired", "…and it CLOSES the ask too");
  }

  {
    const WRITE_TOOL = "notion-create-pages";
    ok(classifyConnectorOpTier(`notion__${WRITE_TOOL}`) !== "read", "the fixture tool really does classify as a NON-read — without this the arm would prove nothing");
    const askId = await craftAsk({ frozenArgs: { id: "reason-mint" }, id: "ask-mint-refused", mcpTool: WRITE_TOOL, scopeKey: "sess-reason-mint" });
    const writeVendor = fakeMcpServer({ tools: [{ inputSchema: VENDOR_SCHEMA, name: WRITE_TOOL }] });
    await failedTap(askId, "mint_refused", "mint_refused", async () =>
      await withPatchedFetch(writeVendor.fetch as unknown as typeof globalThis.fetch, async () => await tap(askId, OWNER_CLICKER)),
    );
  }

  {
    const askId = await craftAsk({ frozenArgs: { id: "reason-standing" }, id: "ask-standing-unavailable", requestedMode: "standing", scopeKey: "sess-reason-standing" });
    const before = dmed.length;
    await failedTap(askId, "standing_unavailable", "standing_unavailable", async () =>
      await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => await resolveGrantCardClick({ answer: "standing", askId, clicker: OWNER_CLICKER, nowMs: clock, ...stamps })),
    );
    eq((await store.getCredentialGrantAsk(ORG, askId))?.status, "pending", "🔴 …and the ask stays PENDING, so the owner can still tap `once` or `this conversation`");
    eq((await store.credentialGrantsForScope(ORG, "sess-reason-standing")).length, 0, "🔴 …and NO grant row was written — the refusal binds nothing, it does not bind something narrower");
    eq(dmed.length, before, "…and nothing was sent to the owner beyond the tap's own private answer");
  }

  {
    const RAW = "U owner d";
    const askId = await craftAsk({ id: "ask-owner-unresolvable", ownerNativeId: RAW, ownerPlatform: "discord", ownerPrincipalId: `discord/${RAW}`, scopeKey: "sess-reason-owner" });
    await failedTap(askId, "owner_unresolvable", "owner_unresolvable", async () =>
      await withPatchedFetch(vendor.fetch as unknown as typeof globalThis.fetch, async () => await tap(askId, { nativeId: RAW, platform: "discord" })),
    );
  }

  {
    const askId = await craftAsk({ id: "ask-click-threw", scopeKey: "sess-reason-threw" });
    const real = store;
    const throwing = new Proxy(real, {
      get: (target, prop) => {
        if (prop === "getCredentialGrantAsk") return async (): Promise<never> => { throw new Error("the operational store is unwell"); };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as OperationalStore;
    registerOperationalStore(throwing);
    resetOperationalStore();
    let result: { outcome: string; text: string };
    try {
      result = await tap(askId, OWNER_CLICKER);
    } finally {
      registerOperationalStore(real);
      resetOperationalStore();
    }
    eq(getOperationalStore(), real, "the real store is back before anything else reads it");
    eq(result.outcome, "failed", "click_threw: a throw inside the route resolves to failed, never to an exception at the surface");
    const detail = await clickRow(askId, "click_threw");
    eq(detail.outcome, "failed", "…and it leaves a row");
    eq(detail.reason, "click_threw", "🔴 …naming the route's own failure — an unaudited tap reads exactly like a tap that never happened");
    drove.click_threw = true;
  }

  {
    const undriven = Object.entries(drove)
      .filter(([, seen]) => !seen)
      .map(([reason]) => reason);
    eq(undriven, [], `every reason in the enum has an arm that drives it (undriven: ${undriven.join(", ") || "none"})`);

    const nonFailed = (await readAudit({ org: ORG, limit: 500 }))
      .filter((r) => r.action === GRANT_CARD_CLICK_ACTION)
      .map((r) => r.detail as Record<string, unknown>)
      .filter((d) => d.outcome !== "failed");
    ok(nonFailed.length >= 4, `there really are non-failed click rows to control against (${nonFailed.length})`);
    ok(
      nonFailed.every((d) => d.reason === undefined && d.linkDelivered === undefined),
      "…and not one of them carries a reason or a linkDelivered — those fields belong to a failed row alone",
    );

    const reasons = new Set(Object.keys(drove));
    const failed = (await readAudit({ org: ORG, limit: 500 }))
      .filter((r) => r.action === GRANT_CARD_CLICK_ACTION)
      .map((r) => r.detail as Record<string, unknown>)
      .filter((d) => d.outcome === "failed");
    ok(
      failed.every((d) => typeof d.reason === "string" && reasons.has(d.reason)),
      "every failed row's reason is one of the closed enum's values — never free text",
    );
  }
}

console.log("7. the ask verb: a turn that read outside content asks as a clean turn does (OPE-2717), and a delegated WORKER holds it while the seat does not:");
{
  ok(
    !allowedOnLeanSeat("request_credential_grant"),
    "🔴 a DELEGATING conversational seat still holds the ask verb — OPE-2023 moved it to the worker, and a seat that asks would raise an ask for a tool that mounts on its workers",
  );
  ok(
    allowedOnWorkerSeat("request_credential_grant"),
    "…and a delegated WORKER holds it (OPE-1343) — the seat delegates, so a seat-only verb was unreachable; the ask it raises is scoped to the ROOT seat, never to the worker's own one-shot session",
  );
  ok(WORKER_ONLY_TOOLS_STANDING.includes("request_credential_grant"), "…so the worker-capability index TELLS the seat to delegate it — without that line the seat has no route to name");

  const ask = { connector: "notion", owner: OWNER, purpose: "read it for me", requested_mode: "once", target_label: "A page", tool: "notion-fetch" };
  const runAsk = async (mark: boolean) =>
    inEveContext(new FakeEveContext(), async () => {
      if (mark) {
        noteEnvelopeWrapThisTurn();
        ok(envelopeWrappedThisTurn(undefined), "the fixture really did mark the turn — without this the leg below would pass on an unmarked turn");
      } else {
        ok(!envelopeWrappedThisTurn(undefined), "the control turn is genuinely clean");
      }
      return (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(ask, {})) as {
        asked: boolean;
        message: string;
      };
    });
  const clean = await runAsk(false);
  const marked = await runAsk(true);
  ok(!marked.message.includes("read external content"), "a turn that read outside content is NOT refused for taint");
  eq(marked.asked, clean.asked, "…it gets the clean turn's outcome");
  eq(marked.message, clean.message, "…with the clean turn's exact message, so no taint condition survives below the old gate");

  const wrongConnector = await inEveContext(new FakeEveContext(), async () =>
    (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
      { connector: "linear", owner: OWNER, purpose: "read it for me", requested_mode: "once", target_label: "A project", tool: "linear-fetch" },
      {},
    )) as { asked: boolean; message: string },
  );
  eq(wrongConnector.asked, false, "a connector this deployment admits no grant role for is REFUSED");
  ok(wrongConnector.message.includes("not a connector this deployment lends credentials for"), "…by name, naming the boundary");
  ok(wrongConnector.message.includes("notion"), "…and listing what it does admit, so the model can correct itself in one step");

  const badArgs = await inEveContext(new FakeEveContext(), async () =>
    (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
      { connector: "notion", frozen_args: { id: undefined }, owner: OWNER, purpose: "read it", requested_mode: "once", target_label: "A page", tool: "notion-fetch" },
      {},
    )) as { asked: boolean; message: string },
  );
  eq(badArgs.asked, false, "🔴 an argument with NO VALUE is refused — JSON.stringify would DROP the key, and a dropped key is a lost narrowing");
  ok(badArgs.message.includes("has no value"), "…naming the offending key rather than failing inside the store");
}

console.log("8. an ask with NO VERIFIED REQUESTER is refused before anything is written:");
{
  const SCOPE_UNVERIFIED = "sess-unverified-requester";
  const nowIso = (): string => new Date(clock).toISOString();
  dmed.length = 0;
  const before = (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.refused").length;

  const refused = await raise({ requester: undefined, scope: SCOPE_UNVERIFIED });
  eq(refused.sent, false, "🔴 an ask with no verified requester is REFUSED");
  eq(refused.reason, "unverified_requester", "…by that exact name — the reason six prose sites cite");
  eq(refused.askId, undefined, "…and hands back no ask id");
  eq(
    (await store.pendingCredentialGrantAsksForScope(ORG, SCOPE_UNVERIFIED, nowIso())).length,
    0,
    "🔴 …NO ask row is written — the scope is left unclaimed, so the refusal cannot block a later verified ask",
  );
  eq(dmed.length, 0, "🔴 …and NO card reaches the owner's DM — an owner is never asked to decide for nobody");

  const after = (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.refused");
  eq(after.length, before + 1, "…one grant.refused row records the attempt");
  ok(
    after.some((r) => (r.detail as { gate?: unknown } | undefined)?.gate === "unverified_requester"),
    "…naming the gate that refused it",
  );

  dmed.length = 0;
  const allowed = await raise({ scope: SCOPE_UNVERIFIED });
  eq(allowed.sent, true, "🔴 control — the identical ask WITH a verified requester is raised");
  eq((await store.pendingCredentialGrantAsksForScope(ORG, SCOPE_UNVERIFIED, nowIso())).length, 1, "control — and writes its ask row");
  eq(dmed.length, 1, "control — and posts exactly one card, so the leg above measures the missing requester and nothing else");
}

console.log("9. an ask composes with no vendor tool name to look up:");
{
  for (const connector of credentialGrantConnectors()) {
    ok(
      defaultGrantTool(connector) !== undefined,
      `🔴 "${connector}" is admitted for credential grants and has NO default tool — an ask for it can only be composed by a caller that already knows the vendor's name, which is the OPE-1552 dead end`,
    );
  }
  eq(defaultGrantTool("notion"), VENDOR_TOOL, "the Notion default is the name this pack's fixtures and the borrow transport both drive");
  eq(defaultGrantTool("linear"), undefined, "a connector this tree admits no grant role for has NO default — the verb refuses rather than inventing a name");

  const schema = (requestCredentialGrantEntry as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema;
  const askInput = { connector: "notion", owner: OWNER, purpose: "read the launch page", requested_mode: "once", target_label: "Launch page" };
  ok(schema.safeParse(askInput).success, "🔴 an ask that names NO tool is a valid call — the caller cannot look the name up, because the connector it would ask is the one it is borrowing");
  ok(schema.safeParse({ ...askInput, tool: VENDOR_TOOL }).success, "…and an ask that DOES name one is unchanged");
  ok(!schema.safeParse({ ...askInput, tool: "" }).success, "…while an EMPTY tool is still refused — omitting the field and sending a blank name are different claims");

  const chatCtx = {
    session: { auth: { current: { attributes: { oe_grain: "standing", oe_requester: "U-req" } } }, id: "worker-of-sess-chat-1552", parent: { callId: "call-1", sessionId: "sess-chat-1552" } },
  };
  const exec = async (over: Record<string, unknown>): Promise<{ asked: boolean; message: string }> =>
    (await inEveContext(new FakeEveContext(), async () =>
      (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
        { ...askInput, ...over },
        chatCtx,
      )),
    )) as { asked: boolean; message: string };

  const noTool = await exec({});
  const withTool = await exec({ tool: VENDOR_TOOL });
  ok(!noTool.message.includes("must name the vendor's own tool name"), "🔴 an ask with no tool is NOT stopped on the missing name — it walks on to the ordinary gates");
  eq(noTool.message, withTool.message, "…and stops exactly where the identical ask WITH a tool stops, so the missing name changes nothing about the ask's path");
  ok(withTool.message.includes("does not admit credential grants"), "control — both calls stopped on the DOMAIN gate, the one this fixture's surface genuinely fails");

  {
    dmed.length = 0;
    const SCOPE_DEFAULTED = "sess-defaulted-tool";
    const defaulted = defaultGrantTool("notion");
    ok(defaulted !== undefined && defaulted.length > 0, "the default is a non-empty name before anything is asked with it");
    const raised = await raise({ resource: "OPE-1552 default-tool page", scope: SCOPE_DEFAULTED, tool: defaulted ?? "" });
    eq(raised.sent, true, "an ask carrying the DEFAULT tool name is raised");
    const rows = await store.pendingCredentialGrantAsksForScope(ORG, SCOPE_DEFAULTED, new Date(clock).toISOString());
    eq(rows.length, 1, "…and writes exactly one ask row");
    eq(rows[0]?.mcpTool, VENDOR_TOOL, "🔴 …whose vendor tool is the default the verb composes — the name that reaches the owner's approval check");
    eq(dmed.length, 1, "…and one card reaches the owner's DM");
    ok(dmed[0]?.text.includes("read a Notion page"), "…and the card says what that tool DOES, in the words the reviewed table spells for it");
    ok(dmed[0]?.text.includes(VENDOR_TOOL) === false, "…never the vendor tool id, which is unreadable to the person deciding");
  }

  {
    const grantCtx = (sessionId: string): BindableContext =>
      ({
        session: {
          auth: { current: { attributes: { oe_grain: "standing", oe_requester: "U-req" } } },
          id: `worker-of-${sessionId}`,
          parent: { callId: "call-1", sessionId },
        },
      }) as unknown as BindableContext;
    const FIXTURE = resolvePartition(grantCtx("sess-probe"));
    const GRANT_DOMAINS = [defineDomain({ name: "grant-ask-fixture", reach: [FIXTURE.surfaceKey], credentialGrants: ["notion"] })];
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains: () => GRANT_DOMAINS,
      loadSilos: () => [],
      domainsForSurface: ({ workspaceKey, surface }) => GRANT_DOMAINS.filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
    });
    const ENVELOPE = '<message trigger="true" from="human" author-id="U-req">read the launch page</message>';
    const drive = async (sessionId: string, over: Record<string, unknown>): Promise<{ asked: boolean; message: string }> =>
      await inEveContext(new FakeEveContext(), async () => {
        const ctx = grantCtx(sessionId);
        recordRequesterIdentity(ctx, undefined, ENVELOPE);
        return (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
          { connector: "notion", owner: OWNER, purpose: "read the launch page", requested_mode: "once", ...over },
          ctx,
        )) as { asked: boolean; message: string };
      });
    const rowsFor = async (scopeKey: string): Promise<readonly { mcpTool?: string }[]> =>
      await store.pendingCredentialGrantAsksForScope(ORG, scopeKey, new Date().toISOString());

    dmed.length = 0;
    const DEFAULTED_SCOPE = "sess-1552-verb-defaulted";
    const defaulted = await drive(DEFAULTED_SCOPE, { target_label: "OPE-1552 verb default page" });
    eq(defaulted.asked, true, "🔴 the SHIPPED VERB raises an ask with no `tool` named — the whole point of OPE-1552");
    const defaultedRows = await rowsFor(DEFAULTED_SCOPE);
    eq(defaultedRows.length, 1, "…writing exactly one ask row");
    eq(defaultedRows[0]?.mcpTool, VENDOR_TOOL, "🔴 …whose vendor tool is the CONNECTOR'S DEFAULT — the verb composed the name the caller could not look up");
    eq(dmed.length, 1, "…and one card reaches the owner's DM");
    ok(dmed[0]?.text.includes("read a Notion page"), "🔴 …saying what that same tool DOES, so the owner decides on the borrow the row will actually spend");

    dmed.length = 0;
    const NAMED_SCOPE = "sess-1552-verb-named";
    const OTHER_TOOL = "notion-search";
    const named = await drive(NAMED_SCOPE, { target_label: "OPE-1552 verb named page", tool: OTHER_TOOL });
    eq(named.asked, true, "control — the identical ask that DOES name a tool is raised too");
    const namedRows = await rowsFor(NAMED_SCOPE);
    eq(namedRows[0]?.mcpTool, OTHER_TOOL, "🔴 control — and carries the CALLER'S name, not the default: an explicit name still wins");
    ok(dmed[0]?.text.includes("read one thing in Notion") === true, "control — an UNREVIEWED tool reads as the generic floor, not as the default tool's phrase");
    ok(dmed[0]?.text.includes("read a Notion page") === false, "control — …so the two tools do not render the same card");
    ok(dmed[0]?.text.includes("no plain description") === true, "control — …and the owner is warned that this deployment cannot describe it, and steered to decline");
    ok(dmed[0]?.text.includes(OTHER_TOOL) === false && dmed[0]?.text.includes(VENDOR_TOOL) === false, "control — and NEITHER vendor id appears");
  }
}

console.log("10. a refused grant road leaves a row naming the floor that refused it:");
{
  const mountRows = async (): Promise<readonly { readonly detail?: unknown }[]> =>
    (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.mount_refused");
  const reasonsOf = (rows: readonly { readonly detail?: unknown }[]): readonly unknown[] => rows.map((r) => (r.detail as { reason?: unknown } | undefined)?.reason);
  const ctxOf = (sessionId: string, grain: string): BindableContext =>
    ({ session: { auth: { current: { attributes: { oe_grain: grain } } }, id: sessionId } }) as unknown as BindableContext;
  const workerOf = (sessionId: string): BindableContext =>
    ({
      session: { auth: { current: { attributes: { oe_grain: "standing", oe_requester: "U-req" } } }, id: `worker-of-${sessionId}`, parent: { callId: "call-1", sessionId } },
    }) as unknown as BindableContext;
  const FIXTURE_SURFACE = resolvePartition(ctxOf("sess-1916-probe", "standing")).surfaceKey;
  const useDomains = (domains: ReturnType<typeof defineDomain>[]): void => {
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains: () => domains,
      loadSilos: () => [],
      domainsForSurface: () => domains.map((d) => d.name),
    });
  };
  const GRANTING = defineDomain({ name: "grant-1916-granting", reach: [FIXTURE_SURFACE], credentialGrants: ["notion"] });
  const SILENT = defineDomain({ name: "grant-1916-silent", reach: [FIXTURE_SURFACE] });

  _resetGrantMountAuditForTest();

  useDomains([GRANTING]);
  {
    const before = (await mountRows()).length;
    eq(requestCredentialGrantMount(ctxOf("sess-1916-grain", "task")), false, "a non-conversational grain does NOT mount the ask verb");
    await _grantMountAuditSettled();
    const rows = await mountRows();
    eq(rows.length, before + 1, "…and writes exactly one grant.mount_refused row");
    eq((rows[0]?.detail as { reason?: unknown } | undefined)?.reason, "grain", "🔴 …naming the GRAIN floor — the cause an operator would otherwise have to guess");
    eq((rows[0]?.detail as { grain?: unknown } | undefined)?.grain, "task", "…and carrying the grain it read, so the row says which seat was refused");
    eq((rows[0]?.detail as { surfaceKey?: unknown } | undefined)?.surfaceKey, FIXTURE_SURFACE, "…and the surface key, so the row joins to a room");
  }

  {
    useDomains([]);
    const before = (await mountRows()).length;
    eq(requestCredentialGrantMount(workerOf("sess-2106-nocontext")), false, "a worker outside eve's context does not mount the ask verb");
    await _grantMountAuditSettled();
    let rows = await mountRows();
    eq(rows.length, before + 1, "…and writes exactly one row");
    eq((rows[0]?.detail as { reason?: unknown } | undefined)?.reason, "binding-unresolved", "🔴 …naming BINDING-UNRESOLVED, not the no-domain config gap");
    eq((rows[0]?.detail as { slot?: unknown } | undefined)?.slot, "no-context", "🔴 …with slot=no-context: the caller ran outside eve's context scope");
    eq((rows[0]?.detail as { surfaceKey?: unknown } | undefined)?.surfaceKey, "subagent/dev/unresolved", "…on the sentinel surface key the measured row carried");
    await inEveContext(new FakeEveContext(), async () => {
      eq(requestCredentialGrantMount(workerOf("sess-2106-empty")), false, "a worker with an EMPTY slot does not mount the ask verb");
    });
    await _grantMountAuditSettled();
    rows = await mountRows();
    eq((rows[0]?.detail as { reason?: unknown } | undefined)?.reason, "binding-unresolved", "an empty slot is binding-unresolved too");
    eq((rows[0]?.detail as { slot?: unknown } | undefined)?.slot, "empty", "🔴 …but with slot=empty, so a reader can tell the two apart");
  }

  {
    useDomains([]);
    const before = (await mountRows()).length;
    await inEveContext(new FakeEveContext(), async () => {
      const binding = bindFrom(ctxOf("sess-1916-nodomain-bind", "standing"));
      ok(adoptDelegatedAuthority({ binding, requester: { kind: "none" }, nonMemberWake: false }, undefined), "the worker adopts its dispatch binding");
      eq(requestCredentialGrantMount(workerOf("sess-1916-nodomain")), false, "a surface in NO domain does not mount the ask verb");
    });
    await _grantMountAuditSettled();
    const rows = await mountRows();
    eq(rows.length, before + 1, "…and writes exactly one row");
    eq((rows[0]?.detail as { reason?: unknown } | undefined)?.reason, "no-domain", "🔴 …naming the NO-DOMAIN floor, which is a config gap rather than a seat shape");
    eq((rows[0]?.detail as { slot?: unknown } | undefined)?.slot, undefined, "…and carrying no slot field, because the binding was readable");
  }

  {
    useDomains([SILENT]);
    const before = (await mountRows()).length;
    eq(requestCredentialGrantMount(workerOf("sess-1916-nodecl")), false, "a domain that declares NO credential grant does not mount the ask verb");
    await _grantMountAuditSettled();
    const rows = await mountRows();
    eq(rows.length, before + 1, "…and writes exactly one row");
    eq((rows[0]?.detail as { reason?: unknown } | undefined)?.reason, "no-declaration", "🔴 …naming the DECLARATION floor — the domain is reachable, the operator just never declared the grant");
  }

  {
    const last5 = (await mountRows()).slice(0, 5);
    eq([...new Set(reasonsOf(last5))].sort(), ["binding-unresolved", "grain", "no-declaration", "no-domain"], "🔴 the four causes write four DIFFERENT reasons");
  }

  {
    useDomains([GRANTING]);
    const before = (await mountRows()).length;
    eq(requestCredentialGrantMount(workerOf("sess-1916-ok")), true, "control — the identical WORKER in a DECLARING domain DOES mount the ask verb");
    await _grantMountAuditSettled();
    eq((await mountRows()).length, before, "🔴 control — and writes NO grant.mount_refused row");
  }

  {
    useDomains([SILENT]);
    const before = (await mountRows()).length;
    const ctx = workerOf("sess-1916-dedupe");
    eq(requestCredentialGrantMount(ctx), false, "the first resolution of a refused session is refused");
    await _grantMountAuditSettled();
    eq(requestCredentialGrantMount(ctx), false, "…and so is the second");
    await _grantMountAuditSettled();
    eq((await mountRows()).length, before + 1, "🔴 …but the log carries ONE row for the two — the dedupe auditGateOnce uses, for the same reason");
    _resetGrantMountAuditForTest();
    eq(requestCredentialGrantMount(ctx), false, "control — the same session refused again after the dedupe is reset");
    await _grantMountAuditSettled();
    eq((await mountRows()).length, before + 2, "control — writes a SECOND row, so the dedupe above measured the dedupe and not a dead road");
  }

  const refusedRows = async (): Promise<readonly { readonly detail?: unknown }[]> =>
    (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.refused");
  const gateOf = (rows: readonly { readonly detail?: unknown }[]): unknown => (rows[0]?.detail as { gate?: unknown } | undefined)?.gate;
  const ENVELOPE_1916 = '<message trigger="true" from="human" author-id="U-req">read the launch page</message>';
  const driveVerb = async (ctx: BindableContext, over: Record<string, unknown>): Promise<{ asked: boolean; message: string }> =>
    await inEveContext(new FakeEveContext(), async () => {
      recordRequesterIdentity(ctx, undefined, ENVELOPE_1916);
      return (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
        { connector: "notion", owner: OWNER, purpose: "read the launch page", requested_mode: "once", target_label: "OPE-1916 page", ...over },
        ctx,
      )) as { asked: boolean; message: string };
    });

  useDomains([GRANTING]);

  {
    const before = (await refusedRows()).length;
    const noSession = {
      channel: { kind: "subagent" },
      session: { auth: { current: { attributes: { oe_grain: "standing", oe_requester: "U-req" } } }, id: "worker-unplaceable" },
    } as unknown as BindableContext;
    const out = await driveVerb(noSession, {});
    eq(out.asked, false, "a delegated task this host cannot place in a conversation is refused");
    ok(out.message.includes("no session id"), "…by that name");
    const rows = await refusedRows();
    eq(rows.length, before + 1, "🔴 …and the refusal now leaves a grant.refused row");
    eq(gateOf(rows), "no_scope_key", "🔴 …naming its own gate, distinct from every other refusal on this plane");
  }

  {
    const before = (await refusedRows()).length;
    dmed.length = 0;
    const out = await driveVerb(workerOf("sess-1916-badowner"), { owner: "slack/U-owner" });
    eq(out.asked, false, "an owner string that names NOBODY is refused");
    eq(dmed.length, 0, "…and no card reaches anyone — a refusal here must not guess at a person");
    const rows = await refusedRows();
    eq(rows.length, before + 1, "🔴 …and the refusal leaves a grant.refused row");
    eq(gateOf(rows), "owner_unresolved", "🔴 …naming its own gate");
    eq((rows[0]?.detail as { owner?: unknown } | undefined)?.owner, undefined, "🔴 …and NOT the unresolved owner string, which is model-authored and names nobody");
    eq((rows[0]?.detail as { scopeKey?: unknown } | undefined)?.scopeKey, "sess-1916-badowner", "🔴 OPE-2063: …and it carries the root seat's scopeKey, so a session wait can find it");
  }

  {
    const before = (await refusedRows()).length;
    dmed.length = 0;
    const out = await driveVerb(workerOf("sess-1916-control"), { target_label: "OPE-1916 control page" });
    eq(out.asked, true, "🔴 control — the identical ask with a session and a resolvable owner IS raised");
    eq(dmed.length, 1, "control — and one card reaches the owner's DM");
    eq((await refusedRows()).length, before, "control — and writes NO grant.refused row, so the two arms above measured their own gates");
  }
}

console.log("10. the standing binding reaches the ask:");
{
  const DOMAIN = "oe-grant-domain::acme";
  const OTHER_DOMAIN = "oe-grant-domain::other-co";
  const askedRows = async (): Promise<readonly { readonly detail?: unknown }[]> =>
    (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.asked");
  const refused1950 = async (): Promise<readonly { readonly detail?: unknown }[]> =>
    (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.refused");
  const detail = (rows: readonly { readonly detail?: unknown }[]): { gate?: unknown; scopeKey?: unknown; domainScopeKey?: unknown } =>
    (rows[0]?.detail ?? {}) as { gate?: unknown; scopeKey?: unknown; domainScopeKey?: unknown };

  const recorded = await raise({ domain: DOMAIN, frozenArgs: { id: "dom-1" }, mode: "standing", scope: "sess-1950-a" });
  eq(recorded.sent, true, "an ask raised in a windowed room goes out");
  const askRow = await store.getCredentialGrantAsk(ORG, recorded.askId!);
  eq(askRow?.scopeKey, "sess-1950-a", "the ask row is filed under the ASKING SESSION, whatever mode was requested");
  eq(askRow?.domainScopeKey, DOMAIN, "…and records the room's DOMAIN key beside it, which is what a STANDING answer binds to");
  const askAudit = detail(await askedRows());
  eq(askAudit.scopeKey, "sess-1950-a", "the grant.asked row names the asking session");
  eq(askAudit.domainScopeKey, DOMAIN, "🔴 …and names the domain scope, so an operator can join a later domain-keyed grant back to its ask");

  const noDomain = await raise({ frozenArgs: { id: "dom-2" }, mode: "standing", scope: "sess-1950-b" });
  eq((await store.getCredentialGrantAsk(ORG, noDomain.askId!))?.domainScopeKey, undefined, "NEGATIVE CONTROL: a room that resolves no windowed domain records no domain key — the flow never invents one");

  const domainGrant = (over: Partial<{ id: string; mode: "once" | "session" | "standing"; scopeKey: string; frozen: Record<string, unknown> }>): Parameters<typeof store.addCredentialGrant>[1] => ({
    askId: `ask-${over.id ?? "x"}`,
    connector: "notion",
    createdAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 30 * 24 * 60 * 60_000).toISOString(),
    frozenArgs: over.frozen ?? { id: "dom-live" },
    id: over.id ?? "x",
    mcpTool: "notion-fetch",
    mode: over.mode ?? "standing",
    ownerPrincipalId: OWNER,
    ownerSlug: "rowan_hale",
    purpose: "read the launch page",
    requesterPrincipalId: REQ,
    resource: "Launch page",
    scopeKey: over.scopeKey ?? DOMAIN,
    status: "active",
    tier: "read",
    toolName: "grant__rowan_hale_notion__notion_fetch_launch",
    verb: "notion_fetch",
  });
  await store.addCredentialGrant(ORG, domainGrant({ id: "g-1950-standing" }));
  const nagged = await raise({ domain: DOMAIN, frozenArgs: { id: "dom-live" }, mode: "standing", scope: "sess-1950-rotated" });
  eq(nagged.sent, false, "🔴 THE ANTI-NAG HALF: a FRESH session in the same room is refused, so a seat rotation does not re-card the owner");
  eq(nagged.reason, "grant_already_live", "…by name — the live standing grant it would duplicate is what refuses it");
  const refusalAudit = detail(await refused1950());
  eq(refusalAudit.gate, "grant_already_live", "the refusal writes its row");
  eq(refusalAudit.domainScopeKey, DOMAIN, "🔴 …carrying the DOMAIN scope, which is the only row a rotated rerun can read its own domain key from");

  await store.addCredentialGrant(ORG, domainGrant({ frozen: { id: "dom-session-mode" }, id: "g-1950-session-mode", mode: "session" }));
  const sessionModeRow = await raise({ domain: DOMAIN, frozenArgs: { id: "dom-session-mode" }, mode: "standing", scope: "sess-1950-c" });
  eq(sessionModeRow.sent, true, "🔴 NEGATIVE CONTROL: a SESSION-mode row spelled with the domain key does NOT refuse — the mode decides, never the shape of the string");

  await store.addCredentialGrant(ORG, domainGrant({ frozen: { id: "dom-elsewhere" }, id: "g-1950-elsewhere", scopeKey: OTHER_DOMAIN }));
  const otherRoom = await raise({ domain: DOMAIN, frozenArgs: { id: "dom-elsewhere" }, mode: "standing", scope: "sess-1950-d" });
  eq(otherRoom.sent, true, "🔴 NEVER ACROSS DOMAINS: another room's live standing grant does not refuse an ask raised here");

  const unwindowed = await raise({ frozenArgs: { id: "dom-live" }, mode: "standing", scope: "sess-1950-e" });
  eq(unwindowed.sent, true, "NEGATIVE CONTROL: a room with no domain key reads only its own session, so the domain arm is the only thing that widened");

  const probeCtx = (sessionId: string): BindableContext =>
    ({
      session: { auth: { current: { attributes: { oe_grain: "standing" }, principalId: "U_PROBE", principalType: "test-user" } }, id: sessionId },
    }) as unknown as BindableContext;
  const PROBE = resolvePartition(probeCtx("sess-1950-probe"));
  const ROOM_DOMAIN = defineDomain({ name: "grant-1950-room", reach: [PROBE.surfaceKey], credentialGrants: ["notion"] });
  const useDomains1950 = (loadDomains: () => readonly ReturnType<typeof defineDomain>[]): void => {
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains,
      loadSilos: () => [],
      domainsForSurface: () => [ROOM_DOMAIN.name],
    });
  };
  const AWAY_DOMAIN = defineDomain({ name: "grant-1950-elsewhere", reach: ["slack/T-other/C-other"], credentialGrants: ["notion"] });
  useDomains1950(() => [ROOM_DOMAIN]);
  const windowed = <T>(fn: () => T): T => {
    registerSettings({ window: { topology: true } });
    try {
      return fn();
    } finally {
      resetSettingsForTest();
    }
  };
  const topologyOff = <T>(fn: () => T): T => {
    registerSettings({ window: { topology: false } });
    try {
      return fn();
    } finally {
      resetSettingsForTest();
    }
  };
  const asMode = <T>(mode: string | undefined, fn: () => T): T => {
    const before = process.env.OE_MODE;
    if (mode === undefined) delete process.env.OE_MODE;
    else process.env.OE_MODE = mode;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.OE_MODE;
      else process.env.OE_MODE = before;
    }
  };

  const shipped = asMode("channel", () => topologyOff(() => grantDomainScopeKey(probeCtx("sess-1950-shipped"))));
  eq(shipped, "oe-grant-domain::grant-1950-room", "🔴 with `window.topology` OFF, a declared room still resolves its domain scope");
  eq(
    asMode("channel", () => windowed(() => grantDomainScopeKey(probeCtx("sess-1950-armed")))),
    shipped,
    "…and ARMING the topology changes nothing — the seat's shape is no longer an input to the binding",
  );
  ok(!(shipped ?? "").startsWith("oe-domain::"), `🔴 …and the key is NOT the seat's registry-key spelling, which would invite a future reader to join two different things (read: ${String(shipped)})`);
  ok(
    asMode("channel", () => windowed(() => grantDomainScopeKey(probeCtx("sess-1950-notseat")))) !== windowed(() => supervisorGrainFor(domainKeyOf(PROBE), [ROOM_DOMAIN]).registryKey),
    "🔴 NEGATIVE CONTROL, stated against the derivation it replaced: the grant scope is NOT the seat registry key, even with the topology armed and both resolvable",
  );

  useDomains1950(() => [AWAY_DOMAIN]);
  eq(asMode("channel", () => grantDomainScopeKey(probeCtx("sess-1950-homeless"))), undefined, "🔴 a room the deployment placed in NO domain resolves no domain scope — the exact-session rule, fail closed");
  useDomains1950(() => [ROOM_DOMAIN]);
  ok(asMode("channel", () => grantDomainScopeKey(probeCtx("sess-1950-home"))) !== undefined, "NEGATIVE CONTROL: the same room DOES resolve one once its domain is declared, so the leg above measures membership and not a broken read");

  const ORG_CATCHALL = defineDomain({ name: "grant-1950-org", match: "org" });
  useDomains1950(() => [ORG_CATCHALL, AWAY_DOMAIN]);
  eq(
    asMode("channel", () => grantDomainScopeKey(probeCtx("sess-1950-catchall"))),
    undefined,
    "🔴 a room that reaches a domain ONLY through the `org` catch-all resolves no domain scope — a deployment-wide standing grant is the widening the ruling refuses",
  );
  ok(
    standingSeatDomainFor(domainKeyOf(PROBE), [ORG_CATCHALL, AWAY_DOMAIN])?.name === ORG_CATCHALL.name,
    "…and the WIDER helper really would have answered that catch-all, so the leg above measures the narrowing and not an absent domain",
  );
  useDomains1950(() => [ROOM_DOMAIN]);

  eq(asMode("dm", () => grantDomainScopeKey(probeCtx("sess-1950-dm"))), undefined, "🔴 a DM resolves NO domain scope — a private consent can never bind to the room's domain");
  eq(asMode("mpim", () => grantDomainScopeKey(probeCtx("sess-1950-mpim"))), undefined, "🔴 …and neither does a group DM");
  ok(asMode("channel", () => grantDomainScopeKey(probeCtx("sess-1950-chan2"))) !== undefined, "🔴 NEGATIVE CONTROL: the SAME context in a channel DOES resolve one — the two legs above measure the mode gate, not a function that answers undefined to everything");

  eq(asMode(undefined, () => grantDomainScopeKey(probeCtx("sess-1950-unclassified"))), undefined, "🔴 a context NO mapper classified resolves no domain scope — a gap-filled `channel` is not a classification");
  ok(asMode(undefined, () => bindFrom(probeCtx("sess-1950-gapfill")).mode) === "channel", "…and the gap-fill really does read `channel`, so the leg above is the PROVENANCE test and not a mode test");
  eq(asMode(undefined, () => bindFrom(probeCtx("sess-1950-gapfill2")).modeResolved), undefined, "…while `modeResolved` is absent, which is the one fact that tells the two apart");

  useDomains1950(() => {
    throw new Error("domains unreadable");
  });
  eq(asMode("channel", () => grantDomainScopeKey(probeCtx("sess-1950-broken"))), undefined, "🔴 an unreadable domain config resolves NO domain scope — the fail-closed direction");
  useDomains1950(() => [ROOM_DOMAIN]);
}

{
  const description = String((requestCredentialGrantEntry as unknown as { description: string }).description);

  ok(
    !/Raise it as soon as you know whose account it is/.test(description),
    "🔴 the description still tells the model to raise the ask as soon as it knows whose account it is — the line the S24 red was measured under",
  );

  const flat = description.replace(/\s+/g, " ");
  ok(/own account/i.test(description), "the description no longer says the ask is for a person's OWN account");
  ok(
    !/TWO THINGS NEED THIS ASK/i.test(flat),
    "🔴 the description still names TWO reasons to raise the ask — the second one is what let a seat start an ask nobody asked for",
  );
  ok(
    /NOBODY HAS BOUND HERE is a reason to SUGGEST/i.test(flat),
    "🔴 an unbound connector is not named as a reason to SUGGEST the grant road — the only thing it may now start",
  );
  ok(
    /not granted to this surface" is a reason to SUGGEST/i.test(flat),
    '🔴 a `not granted to this surface` refusal is still named as the REASON TO ASK — OPE-1978 makes it a reason to SUGGEST',
  );

  ok(/do not ask twice/i.test(flat), "the description no longer tells the model not to ask twice");
  ok(/work the org's own road already does/i.test(flat), "the description no longer forbids an ask for work the org's own road already does");

  ok(/REST skill/i.test(description), "the description does not name the REST skill on the team integration key as the org road");
  ok(/already bound to this conversation/i.test(description), "the description does not name an already-bound connector as the org road");
  ok(/delegat/i.test(description), "the description does not say the org road is reached by delegating — a lean seat holds neither of those tools");

  ok(!/refused/i.test(description.split("There is no TOOL NAME")[0] ?? ""), "🔴 the new copy promises a refusal for a needless ask — nothing in this tree refuses one");
}

console.log("12. the ask verb records whether a person's own words asked for the borrow:");
{
  const RECOGNISED_WORDS = "please use my own notion account for this";
  const recognised = namedOwnAccountVendor([RECOGNISED_WORDS], [ownAccountVendorFor("notion")]);
  ok(recognised !== undefined, "fixture guard: the own-account grammar really recognises the wording this leg stamps from");

  const promptExample = /"(lend it my Notion account)"/.exec(GRANTS_SECTION)?.[1];
  ok(promptExample !== undefined, "🔴 the seat prompt's lend trigger no longer carries the vendor-bearing account-word example");
  ok(
    namedOwnAccountVendor([promptExample ?? ""], [ownAccountVendorFor("notion")]) !== undefined,
    "🔴 the grammar recognises the seat prompt's own lend trigger example — the prompt and the measurement agree",
  );
  for (const contentAsk of ["use my Notion", "can you list the pages in my Notion workspace?"]) {
    ok(
      namedOwnAccountVendor([contentAsk], [ownAccountVendorFor("notion")]) === undefined,
      `🔴 the grammar does NOT read the content possessive ${JSON.stringify(contentAsk)} as an own-account ask — nor does the prompt`,
    );
  }

  const seatCtx = (sessionId: string, stamped: boolean): BindableContext =>
    ({
      session: {
        auth: {
          current: {
            attributes: {
              oe_grain: "standing",
              oe_requester: "U-req",
              ...(stamped && recognised !== undefined ? { [OE_OWN_ACCOUNT_ASK_ATTR]: renderOwnAccountStamp(sessionId, undefined, recognised) } : {}),
            },
          },
        },
        id: `worker-of-${sessionId}`,
        parent: { callId: "call-1", sessionId },
      },
    }) as unknown as BindableContext;
  const FIXTURE_1978 = resolvePartition(seatCtx("sess-1978-probe", false));
  const DOMAINS_1978 = [defineDomain({ name: "grant-1978-fixture", reach: [FIXTURE_1978.surfaceKey], credentialGrants: ["notion"] })];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => DOMAINS_1978,
    loadSilos: () => [],
    domainsForSurface: ({ workspaceKey, surface }) => DOMAINS_1978.filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
  });
  const ENVELOPE_1978 = '<message trigger="true" from="human" author-id="U-req">read the launch page</message>';
  const driveAsk = async (sessionId: string, stamped: boolean, targetLabel: string): Promise<{ asked: boolean; message: string }> =>
    await inEveContext(new FakeEveContext(), async () => {
      const ctx = seatCtx(sessionId, stamped);
      recordRequesterIdentity(ctx, undefined, ENVELOPE_1978);
      return (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
        { connector: "notion", owner: OWNER, purpose: "read the launch page", requested_mode: "once", target_label: targetLabel },
        ctx,
      )) as { asked: boolean; message: string };
    });
  const latestAsked = async (): Promise<{ explicit?: unknown }> =>
    ((await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.asked")[0]?.detail ?? {}) as { explicit?: unknown };

  const asked = await driveAsk("sess-1978-asked", true, "OPE-1978 asked-for page");
  eq(asked.asked, true, "fixture guard: the asked-for leg really raised an ask, so there is a row to read");
  eq((await latestAsked()).explicit, true, "🔴 a borrow the person's own words asked for is recorded `explicit: true`");

  const unasked = await driveAsk("sess-1978-unasked", false, "OPE-1978 unasked page");
  eq(unasked.asked, true, "🔴 an ask no recognised words asked for is still RAISED — the column measures, it never refuses");
  eq((await latestAsked()).explicit, false, "🔴 …and its row records `explicit: false`, which is what makes the two readable apart");
}

console.log(`\n✅ credential-grant ask + card lifecycle: ${n} assertions passed`);

// proves: TOOL-request_credential_grant
