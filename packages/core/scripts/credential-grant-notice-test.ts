import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-notice-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;
delete process.env.OE_EGRESS_SPOOF;

import { registerGrantTransport, runGrantedCall } from "../agent/access/credential-grant-broker.js";
import {
  deliverGrantOwnerNotice,
  grantOwnerNoticeText,
  grantRoomNoticeText,
  grantUseNoticeKey,
  postGrantRoomNotice,
  withGrantRoomContext,
} from "../agent/access/credential-grant-notice.js";
import { _resetGrantableVerbsForTest, parseGrantResource, registerGrantableVerb } from "../agent/access/credential-grant.js";
import { approveCredentialGrant, askForCredentialGrant, revokeCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { _resetDynamicVariantsForTest, type ReplayableToolEntry } from "../agent/access/window-gated.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import type { ReplierLabel, ReplyTarget } from "../agent/channels/reply-post.js";
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

const seatCtx = (sessionId: string, stampPlatform = true): BindableContext =>
  ({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
    session: {
      auth: {
        current: {
          attributes: {
            channel_id: "C-ROOM",
            oe_grain: "standing",
            ...(stampPlatform ? { oe_platform: "slack" } : {}),
            team_id: "T1",
            thread_ts: "1777025145.935000",
            trust_checked: "true",
          },
          principalId: "U-req",
          principalType: "slack-user",
        },
      },
      id: sessionId,
    },
  }) as unknown as BindableContext;

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

_resetGrantableVerbsForTest();
_resetDynamicVariantsForTest();

registerGrantableVerb({
  compose(grant) {
    const resource = parseGrantResource(grant.resource);
    return { method: "GET", url: `https://api.notion.com/v1/blocks/${resource?.id ?? ""}/children` };
  },
  connector: "notion",
  describe: (grant) => `Read the one Notion page ${grant.ownerSlug} granted (${grant.resource}).`,
  inputSchema: { properties: {}, type: "object" },
  resourceKind: "page",
  tier: "read",
  verb: "read_page",
});

const sent: string[] = [];
registerGrantTransport("notion", async (request) => {
  sent.push(request.url);
  return { blocks: ["one", "two"] };
});

const askInput = (scopeKey: string, mode: "once" | "session" | "standing") => ({
  ...stamps,
  connector: "notion",
  domainGrantsConnector: true,
  nowMs: NOW,
  ownerHandle: "Rowan Hale",
  ownerNativeId: "U-owner",
  ownerPlatform: "slack",
  ownerPrincipalId: "slack/T1/U-owner",
  purpose: "draft the Q3 summary",
  requestedMode: mode,
  requesterLabel: "Ada",
  requesterPrincipalId: "slack/T1/U-req",
  resource: "notion:page/abc123",
  scopeKey,
  verb: "read_page",
});

const store = getOperationalStore();

const mintGrant = async (scopeKey: string, mode: "once" | "session" | "standing"): Promise<string> => {
  const ask = await askForCredentialGrant(askInput(scopeKey, mode));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", mode, "slack/T1/U-owner", NOW + 500);
  return approved.approved ? approved.grant.id : "";
};

const callThroughMount = async (scopeKey: string): Promise<{ ok: boolean; disclosure?: string; refused?: string }> => {
  const ctx = seatCtx(scopeKey);
  return inEveContext(new FakeEveContext(), async () => {
    recordRequesterIdentity(ctx, undefined, ENVELOPE);
    const mounted = (await (grantTools as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["session.started"](
      { type: "session.started" },
      ctx,
    )) as Record<string, ReplayableToolEntry> | null;
    const entry = mounted?.["grant__rowan_long__read_page"];
    assert.ok(entry !== undefined, "the mount projected the granted tool");
    return (await entry.execute({}, ctx)) as { ok: boolean; disclosure?: string; refused?: string };
  });
};

console.log("1. the host-authored copy:");
{
  const row = { ownerSlug: "rowan_hale", requesterPrincipalId: "slack/T1/U-req" };
  const text = grantRoomNoticeText("acting as rowan_hale — granted tool `read_page` on `notion:page/abc123`", row, "2026-05-04T05:52:01.000Z");
  ok(text.includes("acting as rowan_hale — granted tool"), "the room copy carries the broker's disclosure line VERBATIM — the model authors none of it");
  ok(text.includes("`slack/T1/U-req`'s act"), "…and it names the REQUESTER as the actor (§8.2 bullet 2), not the owner");
  ok(text.includes("run with rowan_hale's credential"), "…and the owner only as the credential holder");
  ok(text.includes("2026-05-04T05:52:01.000Z"), "…and a per-call timestamp, so two uses of one unchanging grant row never render as byte-identical text");
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
  ok(dmed[dmed.length - 1].text.includes("Your notion credential was just used"), "…saying their credential was spent");
  ok(dmed[dmed.length - 1].text.includes(sessionGrant), "…and naming the grant id, which is what a revocation needs");
  ok(dmed[dmed.length - 1].actions === undefined, "…with no buttons: this deployment has no revoke click route, and a dead button is worse than none");
}

console.log("3. the SECOND use: the room sees it again, the owner is not paged again:");
{
  const postsBefore = posted.length;
  const dmsBefore = dmed.length;
  const result = await callThroughMount("session-standing");
  ok(result.ok, "the second call on the same standing grant succeeded");
  eq(posted.length, postsBefore + 1, "the room sees the SECOND use too — every granted call discloses, and the timestamp keeps postOnce from swallowing it");
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
  await withGrantRoomContext({ ctx: seatCtx("session-noroom", false), org: ORG }, () =>
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
  await withGrantRoomContext({ ctx: seatCtx("session-nodm"), org: ORG }, () =>
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
  await withGrantRoomContext({ ctx: seatCtx("session-nodm"), org: ORG }, () =>
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
}

console.log("9. the two halves called directly:");
{
  const grant = await store.getCredentialGrant(ORG, sessionGrant);
  assert.ok(grant !== null, "the revoked grant row is still readable");
  eq(await postGrantRoomNotice(undefined, "acting as rowan_hale", grant, "2026-05-04T05:52:02.000Z"), false, "postGrantRoomNotice with NO context posts nothing and reports false");
  eq(await deliverGrantOwnerNotice(undefined, grant, "2026-05-04T05:52:02.000Z"), false, "deliverGrantOwnerNotice with NO context delivers nothing and reports false");
  eq(
    await deliverGrantOwnerNotice({ ctx: seatCtx("session-standing"), org: ORG }, grant, "2026-05-04T05:52:02.000Z"),
    false,
    "…and a grant whose claim is already held delivers nothing, however it is called",
  );
  ok(grantOwnerNoticeText(grant).includes("`slack/T1/U-req`"), "the owner's DM names WHO ran it — the person they would be revoking against");
  ok(!grantOwnerNoticeText(grant).includes("blocks"), "…and never the vendor OUTPUT: the notice reports the act, never what it read");
}

console.log(`\ncredential-grant-notice: ${n} assertions passed.`);
