import assert from "node:assert/strict";

import { adoptDelegatedAuthority } from "../agent/identity/delegated-binding.js";
import { bindFrom } from "../agent/identity/binding.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-notice-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;
delete process.env.OE_EGRESS_SPOOF;

import { registerGrantBorrowTransport, runGrantedCall } from "../agent/access/credential-grant-broker.js";
import { _resetGrantBorrowTransportsForTest } from "../agent/access/grant-borrow-transport-registry.internal.js";
import {
  deliverGrantOwnerNotice,
  grantOwnerNoticeText,
  grantRoomNoticeText,
  grantUseNoticeKey,
  postGrantRoomNotice,
  withGrantRoomContext,
} from "../agent/access/credential-grant-notice.js";
import { setRegisteredConnectorCredentials, vercelConnectorHome } from "../agent/access/connector-credentials.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { fakeMcpServer } from "./_fake-mcp-server.js";
import { approveCredentialGrant, askForCredentialGrant, revokeCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { _resetDynamicVariantsForTest, type ReplayableToolEntry } from "../agent/access/window-gated.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import type { ReplierLabel, ReplyTarget } from "../agent/channels/reply-post.js";
import { registerAccountDisplayName, _resetAccountDisplayNamesForTest } from "../agent/identity/account-display-name.js";
import { registerSlackFixtureManifest, registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { readAudit } from "../agent/audit/audit.js";
import grantTools from "../agent/tools/grant_tools.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const NOW = Date.now();

const workerCtx = (sessionId: string, stampPlatform = true): BindableContext =>
  ({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
    session: {
      auth: {
        current: {
          attributes: {
            channel_id: "C-ROOM",
            oe_grain: "standing",
            oe_requester: "U-req",
            ...(stampPlatform ? { oe_platform: "slack" } : {}),
            team_id: "T1",
            thread_ts: "1777025145.935000",
            trust_checked: "true",
          },
          principalId: "U-req",
          principalType: "slack-user",
        },
      },
      id: `worker-of-${sessionId}`,
      parent: { callId: "call-1", sessionId },
    },
  }) as unknown as BindableContext;

const seatCtx = (sessionId: string, stampPlatform = true): BindableContext => {
  const c = workerCtx(sessionId, stampPlatform) as unknown as { session: Record<string, unknown> };
  return { ...(c as object), session: { ...c.session, id: sessionId, parent: undefined } } as unknown as BindableContext;
};
const adoptSeatAuthority = (sessionId: string): void => {
  adoptDelegatedAuthority({ binding: bindFrom(seatCtx(sessionId)), nonMemberWake: false, requester: { kind: "requester", principalId: "U-req" } }, undefined);
};

const ENVELOPE = '<message trigger="true" from="human" author-id="slack/T1/U-req">read the granted page</message>';

const ORG = resolvePartition(seatCtx("probe")).org;
const stamps = { org: ORG, platform: "slack", surface: "slack/T1/C-ROOM", workspace: "T1" };

registerSlackFixtureManifest();
registerSlackFixtureMapper();

const posted: { text: string; replier: ReplierLabel | undefined; target: ReplyTarget }[] = [];
const dmed: DirectMessageRequest[] = [];
const captureDirectMessage = async (input: DirectMessageRequest): Promise<{ messageId: string; surfaceId: string }> => {
  dmed.push(input);
  return { messageId: `dm-${dmed.length}`, surfaceId: "D-owner" };
};
const slackArmMembers = {
  displayNameCapable: true,
  dispatchReply: async (target: ReplyTarget, text: string, replier?: ReplierLabel): Promise<string> => {
    posted.push({ replier, target, text });
    return `ts-${posted.length}`;
  },
  resolveTarget: (bag: { str(k: string): string | undefined; readonly threadTs?: string }): ReplyTarget | null => {
    const channelId = bag.str("channelId");
    return channelId === undefined ? null : { channelId, platform: "slack", threadTs: bag.threadTs };
  },
} as const;
registerPostArm({ ...slackArmMembers, deliverDirectMessage: captureDirectMessage, platform: "slack" });

_resetDynamicVariantsForTest();

const sent: string[] = [];
const MCP_URL = "https://mcp.notion.com/mcp";
const VENDOR_TOOL = "notion-fetch";
setRegisteredConnectorCredentials([
  {
    allows: ["user-oauth"],
    connector: "notion",
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: vercelConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
  },
]);
selectConnectorTransport({ connector: "notion", directUrl: MCP_URL, provider: "notion" });
const vendor = fakeMcpServer({
  tools: [{ inputSchema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" }, name: VENDOR_TOOL }],
});
const BORROW_DEPS = { fetch: vendor.fetch, mintOwnerToken: async (): Promise<string> => "OWNER-TOKEN" };

_resetGrantBorrowTransportsForTest();
registerGrantBorrowTransport("notion", async (call) => {
  sent.push(call.mcpTool);
  return { blocks: ["one", "two"] };
}, "test:credential-grant-notice");

const askInput = (scopeKey: string, mode: "once" | "session" | "standing") => ({
  ...stamps,
  connector: "notion",
  domainGrantsConnector: true,
  explicit: false,
  nowMs: NOW,
  ownerHandle: "Rowan Hale",
  ownerNativeId: "U-owner",
  ownerPlatform: "slack",
  ownerPrincipalId: "slack/T1/U-owner",
  purpose: "draft the Q3 summary",
  requestedMode: mode,
  requesterLabel: "Ada",
  requesterPrincipalId: "slack/T1/U-req",
  frozenArgs: { id: "abc123" },
  mcpTool: VENDOR_TOOL,
  scopeKey,
  targetLabel: "Launch page",
});

const store = getOperationalStore();

const mintGrant = async (scopeKey: string, mode: "once" | "session" | "standing"): Promise<string> => {
  const ask = await askForCredentialGrant(askInput(scopeKey, mode));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", mode, "slack/T1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  return approved.approved ? approved.grant.id : "";
};

const callThroughMount = async (scopeKey: string): Promise<{ ok: boolean; disclosure?: string; refused?: string }> => {
  const ctx = workerCtx(scopeKey);
  return inEveContext(new FakeEveContext(), async () => {
    adoptSeatAuthority(scopeKey);
    recordRequesterIdentity(ctx, undefined, ENVELOPE);
    const mounted = (await (grantTools as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["session.started"](
      { type: "session.started" },
      ctx,
    )) as Record<string, ReplayableToolEntry> | null;
    const entry = mounted?.["grant__rowan_hale_notion__notion_fetch_launch_page"];
    assert.ok(entry !== undefined, "the mount projected the granted tool");
    return (await entry.execute({ id: "abc123" }, ctx)) as { ok: boolean; disclosure?: string; refused?: string };
  });
};

console.log("1. the host-authored copy:");
{
  const row = { ownerSlug: "rowan_hale", requesterPrincipalId: "slack/T1/U-req" };
  const line = "acting as rowan_hale — «the broker's disclosure line, whatever it says»";
  const text = grantRoomNoticeText(line, row, "2026-05-04T05:52:01.000Z");
  ok(text.includes(line), "the room copy carries the broker's disclosure line VERBATIM — the model authors none of it, and this notice reads none of it");
  ok(text.includes("`slack/T1/U-req`'s act"), "…and it names the REQUESTER as the actor (§8.2 bullet 2), not the owner");
  ok(text.includes("run with rowan_hale's credential"), "…and the owner only as the credential holder");

  ok(text.includes("Granted-credential use at 05:52 UTC."), "the room reads a clock time");
  ok(!text.includes("2026-05-04T05:52:01.000Z"), "…and never the ISO instant the column holds");
  eq(
    grantRoomNoticeText(line, row, "not-an-instant"),
    `Granted-credential use. This is \`slack/T1/U-req\`'s act, run with rowan_hale's credential.\n${line}`,
    "…and a stamp that does not parse names NO time rather than falling back to the bytes",
  );
  ok(
    grantRoomNoticeText(line, { ...row, ownerSlug: "9000000000000000003" }, "2026-05-04T05:52:01.000Z").includes("run with the owner's credential"),
    "…and an id-shaped owner slug is dropped for a phrase, never printed",
  );

  eq(
    grantRoomNoticeText(line, row, "2026-05-04T05:52:01.000Z"),
    grantRoomNoticeText(line, row, "2026-05-04T05:52:59.999Z"),
    "two uses of one grant row inside a minute now render identically — so the dedupe must not be armed",
  );
  {
    const src = readFileSync(new URL("../agent/access/credential-grant-notice.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function postGrantRoomNotice"));
    const call = /await postReply\(target, grantRoomNoticeText\(line, grant, atIso, requesterLabel\)\);/u;
    ok(call.test(body.slice(0, body.indexOf("\n}"))), "🔴 postGrantRoomNotice passes postReply NO ReplyAudit, so no org reaches postOnce and the text-keyed dedupe never runs");
  }
  eq(grantUseNoticeKey("g1"), "grant-use:g1", "the owner-notice latch is keyed per grant, so two grants never share one notice");
}

console.log("2. a granted call through the mounted tool posts into the room:");
const sessionGrant = await mintGrant("session-standing", "standing");
{
  const dmsAfterCard = dmed.length;
  const result = await callThroughMount("session-standing");
  ok(result.ok, "the granted call succeeded through the real mounted entry");
  eq(sent.length, 1, "…and sent exactly one vendor request");

  eq(posted.length, 1, "THE ROOM GOT THE LINE — one post, with no model in this tier and nothing else that could author it");
  eq(posted[0].target, { channelId: "C-ROOM", platform: "slack", threadTs: "1777025145.935000" }, "…into the conversation the granted call ran in, resolved from the binding, never from a tool argument");
  ok(posted[0].text.includes(result.disclosure ?? "NO-DISCLOSURE"), "…carrying the SAME host-authored line the broker put in the tool result");
  eq(posted[0].replier, undefined, "…and NO replier label reaches the display-name-capable arm: the post is never re-attributed to the owner (§8.2 bullet 2)");
  ok(posted[0].text.startsWith("Granted-credential use at "), "…and no bracket prefix was baked into the body either, which is how a NON-capable arm would render a replier label");
  ok(posted[0].text.includes("`slack/T1/U-req`'s act"), "…and the copy names the requester as the actor");
  ok(!posted[0].text.includes("blocks"), "…and never the vendor OUTPUT (§8.2: names and ids only), though the transport returned a body with `blocks` in it");

  eq(dmed.length, dmsAfterCard + 1, "THE OWNER GOT A DM on the first use of their grant");
  eq(dmed[dmed.length - 1].principalId, "U-owner", "…addressed to the OWNER's own DM, the same 1:1 the approval card lives in");
  ok(dmed[dmed.length - 1].text.includes("Your Notion credential was just used"), "…saying their credential was spent, naming the vendor as a person writes it");
  ok(!dmed[dmed.length - 1].text.includes(sessionGrant), "…and NOT the grant id: the revoke verb takes a number from its own list, never a uuid");
  ok(
    dmed[dmed.length - 1].text.includes("Tell me here to end it"),
    "…and naming the route that ENDS it (OPE-1637): the owner's own DM, where `revoke_credential_grant` answers",
  );
  ok(dmed[dmed.length - 1].actions === undefined, "…with no buttons: the revoke route is a DM verb, and a card button in a room would be the wrong venue for it");
}

console.log("3. the SECOND use: the room sees it again, the owner is not paged again:");
{
  const postsBefore = posted.length;
  const dmsBefore = dmed.length;
  const result = await callThroughMount("session-standing");
  ok(result.ok, "the second call on the same standing grant succeeded");
  eq(posted.length, postsBefore + 1, "the room sees the SECOND use too — every granted call discloses, and the unarmed dedupe (§1's source pin) is what keeps postOnce from swallowing an identical body");
  eq(dmed.length, dmsBefore, "…and the owner is NOT DMed again: the notice is a first-use affordance, not a pager");
  eq(await store.noticeClaimed(ORG, grantUseNoticeKey(sessionGrant)), true, "…because the lifetime claim for this grant is already held");
}

console.log("4. once-mode — the burn notifies the owner and says the grant is spent:");
{
  const onceGrant = await mintGrant("session-once", "once");
  const dmsBefore = dmed.length;
  const postsBefore = posted.length;
  const result = await callThroughMount("session-once");
  ok(result.ok, "the once grant's single call succeeded");
  eq(posted.length, postsBefore + 1, "the room saw it");
  eq(dmed.length, dmsBefore + 1, "…and the owner was DMed on the burn");
  ok(dmed[dmed.length - 1].text.includes("one-shot grant, so it is now spent"), "…with copy that says the grant is spent, not that more calls may follow");
  ok(!dmed[dmed.length - 1].text.includes("FIRST use"), "NEGATIVE CONTROL: the standing-grant sentence is NOT used for a burn — the branch really branches");
  eq((await store.getCredentialGrant(ORG, onceGrant))?.status, "used", "…and the row is spent");
}

console.log("5. NEGATIVE CONTROL — a refused call posts nothing and DMs nobody:");
{
  eq(await revokeCredentialGrant(stamps, sessionGrant, "slack/T1/U-owner", "thread", NOW + 2000), true, "the owner revokes the standing grant");
  const postsBefore = posted.length;
  const dmsBefore = dmed.length;
  const sentBefore = sent.length;
  const result = await callThroughMount("session-standing");
  eq(result.ok ? "OK" : result.refused, "revoked", "the granted call now refuses");
  eq(sent.length, sentBefore, "…no vendor request was sent");
  eq(posted.length, postsBefore, "…and NO room notice: the arm runs after the vendor call, so a refusal cannot announce an act that never happened");
  eq(dmed.length, dmsBefore, "…and NO owner DM either");
}

console.log("6. NEGATIVE CONTROL — the broker driven OUTSIDE the mount notices nothing:");
{
  const grantId = await mintGrant("session-bare", "standing");
  const postsBefore = posted.length;
  const dmsBefore = dmed.length;
  const result = await runGrantedCall(grantId, {}, { ...stamps, nowMs: NOW + 1000, requesterPrincipalId: "slack/T1/U-req", scopeKey: "session-bare" });
  ok(result.ok, "the granted call itself still succeeds — a notice is never a gate");
  eq(posted.length, postsBefore, "…but nothing was posted to any room");
  eq(dmed.length, dmsBefore, "…and nothing was DMed");
  eq(await store.noticeClaimed(ORG, grantUseNoticeKey(grantId)), false, "…and the first-use claim was NOT burned, so the owner still gets their notice on a real use");
}

console.log("7. an unaddressable room still DMs the owner:");
{
  const grantId = await mintGrant("session-noroom", "standing");
  const postsBefore = posted.length;
  const dmsBefore = dmed.length;
  await withGrantRoomContext({ ctx: seatCtx("session-noroom", false), ...stamps }, () =>
    runGrantedCall(grantId, {}, { ...stamps, nowMs: NOW + 1000, requesterPrincipalId: "slack/T1/U-req", scopeKey: "session-noroom" }),
  );
  eq(posted.length, postsBefore, "the room half posted nothing — an unresolvable target is an honest 'cannot post here'");
  eq(dmed.length, dmsBefore + 1, "…and the owner half still delivered: a room with no post arm must not cost the owner their notice");
}

console.log("7b. no DM arm — the first-use claim survives:");
{
  const grantId = await mintGrant("session-nodm", "standing");
  registerPostArm({ ...slackArmMembers, platform: "slack" });
  const postsBefore = posted.length;
  const dmsBefore = dmed.length;
  await withGrantRoomContext({ ctx: seatCtx("session-nodm"), ...stamps }, () =>
    runGrantedCall(grantId, {}, { ...stamps, nowMs: NOW + 1000, requesterPrincipalId: "slack/T1/U-req", scopeKey: "session-nodm" }),
  );
  eq(posted.length, postsBefore + 1, "the room still saw the line");
  eq(dmed.length, dmsBefore, "…the owner was not DMed, because this deployment holds no DM arm");
  eq(
    await store.noticeClaimed(ORG, grantUseNoticeKey(grantId)),
    false,
    "🔴 …and the LIFETIME claim was NOT burned. A claim taken before the address is resolved would spend this grant's one and only notice on a delivery that could never happen",
  );

  registerPostArm({ ...slackArmMembers, deliverDirectMessage: captureDirectMessage, platform: "slack" });
  await withGrantRoomContext({ ctx: seatCtx("session-nodm"), ...stamps }, () =>
    runGrantedCall(grantId, {}, { ...stamps, nowMs: NOW + 2000, requesterPrincipalId: "slack/T1/U-req", scopeKey: "session-nodm" }),
  );
  eq(dmed.length, dmsBefore + 1, "…the owner IS DMed on the next call, once a DM arm exists");
  eq(await store.noticeClaimed(ORG, grantUseNoticeKey(grantId)), true, "…and only now is the claim held");
}

console.log("8. the audit log:");
{
  const rows = await readAudit({ org: ORG });
  const replies = rows.filter((r) => r.action === "reply.post");
  eq(replies.length, 0, "NOT ONE `reply.post` row across every granted call — the eval scorers read that action as 'the model answered', and a host disclosure must never look like one");
  eq(
    rows.filter((r) => r.action === "grant.used").length,
    7,
    "…while every one of the seven successful granted calls above IS recorded, where a granted call belongs: a `grant.used` row naming both principals",
  );

  const notified = rows.filter((r) => r.action === "grant.notified");
  const noticeDms = dmed.filter((d) => d.text.includes("credential was just used"));
  eq(notified.length, noticeDms.length, "one `grant.notified` row per owner-notice DM that actually went out — the row IS the delivery evidence, not a restatement of intent");
  ok(notified.length > 0, "…and that count is not zero, so the assertion above is a measurement rather than 0 === 0");
  eq(
    notified.filter((r) => r.detail?.outcome === "sent").length,
    notified.length,
    "…every one of them says `sent`, because every DM above was delivered by an arm that returned",
  );
  ok(
    notified.length < rows.filter((r) => r.action === "grant.used").length,
    "…and there are FEWER notice rows than granted calls: the row follows the once-per-grant claim, never the call",
  );
  const sample = notified[0];
  eq(sample.principalId, "slack/T1/U-owner", "the row is attributed to the OWNER — the person it is evidence about");
  eq(sample.detail?.requester, "slack/T1/U-req", "…and carries the REQUESTER too, so it joins to `grant.used` by eye");
  eq(sample.detail?.ownerPlatform, "slack", "…and the platform the DM was addressed on");
  ok(typeof sample.detail?.grantId === "string" && sample.detail.grantId.length > 0, "…and the grant id a revocation would name");
  eq(sample.detail?.resource, undefined, "🔴 …and NEVER the resource: the DM's text is composed from model-authored arguments, and this plane audits ids and names");
}

console.log("8b. the owner DM fails — and the failure is a row:");
{
  const grantId = await mintGrant("session-dmfail", "standing");
  const notifiedBefore = (await readAudit({ org: ORG })).filter((r) => r.action === "grant.notified").length;
  const dmsBefore = dmed.length;
  registerPostArm({
    ...slackArmMembers,
    deliverDirectMessage: async (): Promise<{ messageId: string; surfaceId: string }> => {
      const err = new Error("slack refused chat.postMessage to D-owner");
      err.name = "DmTransportError";
      throw err;
    },
    platform: "slack",
  });
  const result = await callThroughMount("session-dmfail");
  registerPostArm({ ...slackArmMembers, deliverDirectMessage: captureDirectMessage, platform: "slack" });

  ok(result.ok, "the granted call still succeeded — a notice is never a gate, however it fails");
  eq(dmed.length, dmsBefore, "…and no DM was captured, because the arm threw before delivering one");
  const rows = (await readAudit({ org: ORG })).filter((r) => r.action === "grant.notified");
  eq(rows.length, notifiedBefore + 1, "…yet the attempt left EXACTLY ONE new row — the send result is recorded whether or not it worked");
  const row = rows.find((r) => r.detail?.grantId === grantId);
  assert.ok(row !== undefined, "…naming the grant whose owner was not reached");
  eq(row.detail?.outcome, "failed", "…and the row says `failed`, which is the fact an operator asking 'was the owner told?' needs");
  eq(row.detail?.error, "DmTransportError", "…and the error CLASS");
  ok(
    !JSON.stringify(row.detail).includes("D-owner"),
    "🔴 …never the thrown MESSAGE: a transport error quotes the address it could not reach, and an audit row is not the place for it",
  );
  eq(
    await store.noticeClaimed(ORG, grantUseNoticeKey(grantId)),
    true,
    "…and the claim STAYS held: a failed send does not give it back (the pager this design refuses), which is why the row has to exist at all",
  );
}

console.log("9. the two halves called directly:");
{
  const grant = await store.getCredentialGrant(ORG, sessionGrant);
  assert.ok(grant !== null, "the revoked grant row is still readable");
  eq(await postGrantRoomNotice(undefined, "acting as rowan_hale", grant, "2026-05-04T05:52:02.000Z"), false, "postGrantRoomNotice with NO context posts nothing and reports false");
  eq(await deliverGrantOwnerNotice(undefined, grant, "2026-05-04T05:52:02.000Z"), false, "deliverGrantOwnerNotice with NO context delivers nothing and reports false");
  eq(
    await deliverGrantOwnerNotice({ ctx: workerCtx("session-standing"), ...stamps }, grant, "2026-05-04T05:52:02.000Z"),
    false,
    "…and a grant whose claim is already held delivers nothing, however it is called",
  );
  ok(grantOwnerNoticeText(grant, undefined, NOW).includes("`slack/T1/U-req`"), "the owner's DM names WHO ran it, by the principal key the `grant.used` row also carries (OPE-1083)");
  ok(!grantOwnerNoticeText(grant, undefined, NOW).includes("blocks"), "…and never the vendor OUTPUT: the notice reports the act, never what it read");
  ok(grantOwnerNoticeText(grant, undefined, NOW).includes("Tell me here to end it and I will end it now."), "the owner's DM OFFERS the end, because `tools/revoke_credential_grant.ts` now takes it");
  ok(!grantOwnerNoticeText(grant, undefined, NOW).includes("There is no way to revoke it yet"), "…and no longer says the control is absent, which the route made false");
  ok(!grantOwnerNoticeText(grant, undefined, NOW).includes(grant.id), "…and it STILL prints no grant id: the verb lists the owner's own grants and takes a number, never a uuid");
}

console.log("10. a registered display-name arm resolves a label, and the principal key stays visible too:");
{
  _resetAccountDisplayNamesForTest();

  registerAccountDisplayName("slack", async (nativeId) => (nativeId === "U-req" ? { handle: "rae", name: "Rae Chen" } : undefined));

  await mintGrant("session-label", "standing");
  const dmsBefore = dmed.length;
  const result = await callThroughMount("session-label");
  ok(result.ok, "the granted call succeeded");
  eq(dmed.length, dmsBefore + 1, "…and DMed the owner on this grant's first use");

  ok(posted[posted.length - 1].text.includes("Rae Chen (@rae)"), "THE ROOM LINE carries the RESOLVED display label");
  ok(posted[posted.length - 1].text.includes("`slack/T1/U-req`"), "…and STILL carries the principal key — the audit join stays visible");
  ok(dmed[dmed.length - 1].text.includes("Rae Chen (@rae)"), "THE OWNER'S DM carries the resolved label too");
  ok(dmed[dmed.length - 1].text.includes("`slack/T1/U-req`"), "…and the principal key, for the same reason");

  _resetAccountDisplayNamesForTest();
}

console.log("11. NEGATIVE CONTROL — no display-name arm resolves ⇒ the notice falls back to the principal key alone:");
{
  await mintGrant("session-nolabel", "standing");
  const dmsBefore = dmed.length;
  const result = await callThroughMount("session-nolabel");
  ok(result.ok, "the granted call succeeded");
  eq(dmed.length, dmsBefore + 1, "…and DMed the owner on this grant's first use");

  ok(posted[posted.length - 1].text.includes("`slack/T1/U-req`"), "the room line still names the requester, by principal key");
  ok(!posted[posted.length - 1].text.includes("Rae Chen"), "…and never a name this deployment cannot resolve — no arm is registered right now");
  ok(dmed[dmed.length - 1].text.includes("`slack/T1/U-req`"), "the owner's DM names the requester by principal key too");
  ok(!dmed[dmed.length - 1].text.includes("Rae Chen"), "…and no invented name there either");
}

console.log(`\ncredential-grant-notice: ${n} assertions passed.`);
