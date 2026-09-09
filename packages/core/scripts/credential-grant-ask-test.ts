import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-ask-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;
delete process.env.OE_EGRESS_SPOOF;

import { GRANT_CARD_CLICK_ACTION, handleGrantCardClick, resolveGrantCardClick, type GrantClickFailureReason } from "../agent/access/credential-grant-click.js";
import { grantCardActionId, grantCardActions, OE_GRANT_ACTION_PREFIX, parseGrantCardActionId } from "../agent/access/credential-grant-card.js";
import { resolveGrantOwner } from "../agent/access/credential-grant-ask.js";
import { askForCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { setRegisteredConnectorCredentials, vercelConnectorHome } from "../agent/access/connector-credentials.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { registerUserAuthFlow } from "../agent/connections/user-auth-flow.js";
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
import { markUntrustedIngestedThisTurn, untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { credentialGrantConnectors } from "../agent/access/credential-grant.js";
import { classifyConnectorOpTier } from "../agent/access/consequence.js";
import { defaultGrantTool, requestCredentialGrantEntry } from "../agent/tools/request_credential_grant.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { resolvePartition } from "../agent/memory/partition.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";

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
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: vercelConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
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
    now: number;
    tool: string;
    frozenArgs: Record<string, unknown>;
  }> = {},
): Promise<{ sent: boolean; askId?: string; reason?: string; toolName?: string }> {
  const outcome = await askForCredentialGrant({
    connector: "notion",
    domainGrantsConnector: true,
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
    requestedMode: "once",
    requesterLabel: "Requesting Person",
    requesterPrincipalId: "requester" in over ? over.requester : REQ,
    ...("target" in over ? (over.target === undefined ? {} : { requesterTarget: over.target }) : { requesterTarget: JSON.stringify(ROOM) }),
    scopeKey: over.scope ?? "sess-chat-1",
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

  const byBare = await resolveGrantOwner("U-owner", "slack", WS);
  ok(!("refusal" in byBare) && byBare.principalId === OWNER, "a BARE id on the caller's own surface composes the same key — one composer, two spellings");

  const byMention = await resolveGrantOwner("<@U-owner>", "slack", WS);
  ok(!("refusal" in byMention) && byMention.principalId === OWNER, "a surface's MENTION rendering is peeled — it is what a person literally types");

  const bad = await resolveGrantOwner("slack/U-owner", "slack", WS);
  ok("refusal" in bad, "a MALFORMED key refuses — a fuzzy match on whose credential gets spent must never be one character away");
  const empty = await resolveGrantOwner("   ", "slack", WS);
  ok("refusal" in empty, "…and so does an empty name");

  const noTenant = await resolveGrantOwner("U-owner", "slack", "");
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

  const actions = grantCardActions({ id: "ask-uuid-1", requestedMode: "once" } as never);
  eq(actions.length, 4, "the card carries four buttons");
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
    posted[0]?.text.includes("The tool is in this conversation's tool list from the next turn."),
    "…it says the tool ARRIVES instead — the one fact the seat's own tool list cannot carry",
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

console.log("7. the ask verb: a tainted turn may not ask, and both a seat and a delegated worker hold it:");
{
  ok(allowedOnLeanSeat("request_credential_grant"), "a DELEGATING conversational seat keeps the ask verb");
  ok(
    allowedOnWorkerSeat("request_credential_grant"),
    "…and a delegated WORKER holds it too (OPE-1343) — the seat delegates, so a seat-only verb was unreachable; the ask it raises is scoped to the ROOT seat, never to the worker's own one-shot session",
  );
  ok(WORKER_ONLY_TOOLS_STANDING.every((t) => t !== "request_credential_grant"), "…so the worker-capability index never tells the seat to delegate it");

  const askCountBefore = (await store.credentialGrantsForScope(ORG, "sess-taint")).length;
  const ctx = new FakeEveContext();
  const tainted = await inEveContext(ctx, async () => {
    markUntrustedIngestedThisTurn("connector");
    ok(untrustedIngestedThisTurn(), "the fixture really did mark the turn — without this the leg below would pass on an unmarked turn");
    return (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
      { connector: "notion", owner: OWNER, purpose: "read it for me", requested_mode: "once", target_label: "A page", tool: "notion-fetch" },
      {},
    )) as { asked: boolean; message: string };
  });
  eq(tainted.asked, false, "a TAINTED turn is refused");
  ok(tainted.message.includes("read external content"), "…and the refusal names the boundary");
  eq((await store.credentialGrantsForScope(ORG, "sess-taint")).length, askCountBefore, "…and nothing was written");

  const clean = await inEveContext(new FakeEveContext(), async () => {
    ok(!untrustedIngestedThisTurn(), "the control turn is genuinely clean");
    return (await (requestCredentialGrantEntry as unknown as { execute(i: unknown, c: unknown): Promise<{ asked: boolean; message: string }> }).execute(
      { connector: "notion", owner: OWNER, purpose: "read it for me", requested_mode: "once", target_label: "A page", tool: "notion-fetch" },
      {},
    )) as { asked: boolean; message: string };
  });
  ok(!clean.message.includes("read external content"), "a CLEAN turn is NOT refused for taint — it reaches the ordinary gates below it");

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

  const chatCtx = { session: { auth: { current: { attributes: { oe_grain: "standing", oe_requester: "U-req" } } }, id: "sess-chat-1552" } };
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
      ({ session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: sessionId } }) as unknown as BindableContext;
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

console.log(`\n✅ credential-grant ask + card lifecycle: ${n} assertions passed`);
