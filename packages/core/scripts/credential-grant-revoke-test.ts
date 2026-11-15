// proves: grant.revoked

// proves: AP-MOD-core-access-credential-grant-revoke

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-revoke-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { approveCredentialGrant, askForCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { GRANT_ID_LEAK_PATTERNS, grantRevokedRoomText } from "../agent/access/credential-grant-copy.js";
import { ownerGrantListText, ownerLiveGrants, revokeOwnerGrants } from "../agent/access/credential-grant-revoke.js";
import { registerGrantBorrowTransport, runGrantedCall } from "../agent/access/credential-grant-broker.js";
import { _resetGrantBorrowTransportsForTest } from "../agent/access/grant-borrow-transport-registry.internal.js";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { DM_SEAT_CARVE_IN, allowedOnLeanSeat } from "../agent/access/lean-seat.js";
import { CONTRIBUTIONS } from "../agent/contributions.js";
import { setRegisteredConnectorCredentials, oauthConnectorHome } from "../agent/access/connector-credentials.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import type { ReplyTarget } from "../agent/channels/reply-post.js";
import { registerSlackFixtureManifest, registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";
import { fakeMcpServer } from "./_fake-mcp-server.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { bindFrom, type BindableContext } from "../agent/identity/binding.js";
import revokeTool from "../agent/tools/revoke_credential_grant.js";

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
const VENDOR_TOOL = "notion-fetch";
const OWNER_KEY = "slack/T1/U-owner";
const OTHER_OWNER_KEY = "slack/T1/U-other";

registerSlackFixtureManifest();
registerSlackFixtureMapper();

const roomCtx = (sessionId: string): BindableContext =>
  ({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
    session: {
      auth: {
        current: {
          attributes: { channel_id: "C-ROOM", channel_type: "channel", oe_grain: "standing", oe_platform: "slack", team_id: "T1", trust_checked: "true" },
          principalId: "U-req",
          principalType: "slack-user",
        },
      },
      id: sessionId,
    },
  }) as unknown as BindableContext;

const dmCtx = (userId: string, opts: { channel?: boolean; attested?: boolean } = {}): BindableContext =>
  ({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:dm" },
    session: {
      auth: {
        current: {
          attributes: {
            channel_id: opts.channel === true ? "C-ROOM" : "D-OWNER",
            channel_type: opts.channel === true ? "channel" : "im",
            oe_grain: "standing",
            oe_platform: "slack",
            team_id: "T1",
            trust_checked: "true",
            ...(opts.attested === true ? { oe_fire_unattended: "true" } : {}),
          },
          principalId: userId,
          principalType: "slack-user",
        },
      },
      id: `dm-${userId}`,
    },
  }) as unknown as BindableContext;

const ORG = resolvePartition(roomCtx("probe")).org;
const stamps = { org: ORG, platform: "slack", surface: "slack/T1/C-ROOM", workspace: "T1" };
const ENVELOPE = '<message trigger="true" from="human" author-id="slack/T1/U-req">read the granted page</message>';

const posted: { text: string; target: ReplyTarget }[] = [];
const dmed: DirectMessageRequest[] = [];
registerPostArm({
  deliverDirectMessage: async (input: DirectMessageRequest) => {
    dmed.push(input);
    return { messageId: `dm-${String(dmed.length)}`, surfaceId: "D-owner" };
  },
  displayNameCapable: true,
  dispatchReply: async (target: ReplyTarget, text: string): Promise<string> => {
    posted.push({ target, text });
    return `ts-${String(posted.length)}`;
  },
  platform: "slack",
  resolveTarget: (bag: { str(k: string): string | undefined; readonly threadTs?: string }): ReplyTarget | null => {
    const channelId = bag.str("channelId");
    return channelId === undefined ? null : { channelId, platform: "slack", threadTs: bag.threadTs };
  },
});

setRegisteredConnectorCredentials([
  {
    allows: ["user-oauth"],
    connector: "notion",
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: oauthConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
  },
]);
selectConnectorTransport({ connector: "notion", directUrl: "https://mcp.notion.com/mcp", provider: "notion" });
const vendor = fakeMcpServer({ tools: [{ inputSchema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" }, name: VENDOR_TOOL }] });
const BORROW_DEPS = { fetch: vendor.fetch, mintOwnerToken: async (): Promise<string> => "OWNER-TOKEN" };
_resetGrantBorrowTransportsForTest();
const sent: string[] = [];
registerGrantBorrowTransport(
  "notion",
  async (call) => {
    sent.push(call.mcpTool);
    return { blocks: ["one"] };
  },
  "test:credential-grant-revoke",
);

const store = getOperationalStore();

const mintGrant = async (opts: {
  scopeKey: string;
  ownerKey?: string;
  ownerNativeId?: string;
  purpose?: string;
  pageId?: string;
  target?: boolean;
}): Promise<string> => {
  const ask = await askForCredentialGrant({
    ...stamps,
    connector: "notion",
    domainScopeKey: "oe-grant-domain::revoke-test",
    domainGrantsConnector: true,
    explicit: false,
    frozenArgs: { id: opts.pageId ?? "abc123" },
    mcpTool: VENDOR_TOOL,
    nowMs: NOW,
    ownerHandle: "Rowan Hale",
    ownerNativeId: opts.ownerNativeId ?? "U-owner",
    ownerPlatform: "slack",
    ownerPrincipalId: opts.ownerKey ?? OWNER_KEY,
    purpose: opts.purpose ?? "draft the Q3 summary",
    requestedMode: "standing",
    requesterLabel: "Ada",
    requesterPrincipalId: "slack/T1/U-req",
    scopeKey: opts.scopeKey,
    ...(opts.target === false ? {} : { requesterTarget: JSON.stringify({ channelId: "C-ROOM", platform: "slack" }) }),
    targetLabel: "Launch page",
  });
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "standing", opts.ownerKey ?? OWNER_KEY, NOW + 500, undefined, BORROW_DEPS);
  assert.ok(approved.approved, "fixture: the grant minted");
  return approved.grant.id;
};

interface RevokeToolResult {
  readonly ended: number;
  readonly live: number;
  readonly message: string;
  readonly grants: readonly { readonly id: string; readonly number: number }[];
}

const callTool = async (ctx: BindableContext, input: Record<string, unknown>): Promise<RevokeToolResult> =>
  await inEveContext(new FakeEveContext(), async () => (await (revokeTool as { execute(i: unknown, c: unknown): Promise<unknown> }).execute(input, ctx)) as never);

const idForNumber = async (ctx: BindableContext, number: number): Promise<string> => {
  const listed = await callTool(ctx, { action: "list" });
  const handle = listed.grants.find((g) => g.number === number);
  assert.ok(handle !== undefined, `fixture: the listing offers an id for number ${String(number)}`);
  return handle.id;
};

const refusal = async (ctx: BindableContext, input: Record<string, unknown>): Promise<string> => {
  try {
    await callTool(ctx, input);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

console.log("1. the verb is registered everywhere a static tool must be before a seat can reach it:");
{
  ok(Object.prototype.hasOwnProperty.call(TOOL_CONSEQUENCE, "revoke_credential_grant"), "the consequence registry carries a row — an unregistered tool is refused by the gate, not mounted");
  eq(TOOL_CONSEQUENCE.revoke_credential_grant.tier, "open", "…at `open`: ending your own credential loan is de-escalation, and gating an off switch is the one direction this must never take");
  ok(
    !Object.prototype.hasOwnProperty.call(WINDOW_GATED_TOOLS, "revoke_credential_grant"),
    "…and it is NOT grain-gated: the DM wall inside the tool is strictly narrower than any grain, and gating it would only strand the DM seat",
  );
  ok(WINDOW_UNGATED_TOOLS.has("revoke_credential_grant"), "…because it is declared UNGATED outright — the posture is a row it holds, not a table it is missing from");
  ok(DM_SEAT_CARVE_IN.has("revoke_credential_grant"), "…the DM carve-in holds it, so a narrowed DM seat that delegates still keeps it");
  ok(allowedOnLeanSeat("revoke_credential_grant", true), "…a LEAN DM seat may hold it");
  ok(!allowedOnLeanSeat("revoke_credential_grant", false), "NEGATIVE CONTROL: a lean seat that is not a DM does not — the carve-in is seat-shaped, not a blanket roster row");
  const contributed = CONTRIBUTIONS.contributions.filter((c) => c.kind === "tool" && c.name === "revoke_credential_grant");
  eq(contributed.length, 1, "…and the contribution manifest names it exactly once, so `oe build` offers it to the app's roster");
  eq(contributed[0]?.module, "agent/tools/revoke_credential_grant.js", "…pointing at the module that actually holds it");
}

console.log("2. liveCredentialGrantsForOwner answers one owner's live rows and nothing else:");
const grantA = await mintGrant({ purpose: "draft the Q3 summary", scopeKey: "chat-a" });
const grantB = await mintGrant({ pageId: "def456", purpose: "check the launch checklist", scopeKey: "chat-b" });
{
  const live = await ownerLiveGrants(ORG, OWNER_KEY, NOW + 1_000);
  eq(
    live.map((h) => h.grant.id),
    [grantA, grantB],
    "both live grants, OLDEST FIRST — so a grant approved while the owner reads this list appends instead of renumbering what they are looking at",
  );
  eq(live.map((h) => h.ordinal), [1, 2], "…numbered 1..n, which is the handle the owner names");

  const otherGrant = await mintGrant({ ownerKey: OTHER_OWNER_KEY, ownerNativeId: "U-other", scopeKey: "chat-c" });
  const mine = await ownerLiveGrants(ORG, OWNER_KEY, NOW + 1_000);
  ok(!mine.some((h) => h.grant.id === otherGrant), "NEGATIVE CONTROL: another owner's live grant is NOT in this owner's list — the read is keyed by owner, so nobody can see whose credential is lent but their own");
  eq((await ownerLiveGrants(ORG, OTHER_OWNER_KEY, NOW + 1_000)).map((h) => h.grant.id), [otherGrant], "…and that owner sees exactly their own");

  const stale = await mintGrant({ pageId: "old999", scopeKey: "chat-stale" });
  eq((await store.getCredentialGrant(ORG, stale))?.status, "active", "fixture: the stale row's STATUS is still active — no sweep has run");
  const farFuture = NOW + 400 * 24 * 3_600_000;
  ok(
    !(await ownerLiveGrants(ORG, OWNER_KEY, farFuture)).some((h) => h.grant.id === stale),
    "…and an UNSWEPT row past its expiry is not offered: expiry is in the predicate, never the status column alone",
  );
  ok((await ownerLiveGrants(ORG, OWNER_KEY, NOW + 1_000)).some((h) => h.grant.id === stale), "NEGATIVE CONTROL: the same row IS offered before its expiry — the exclusion is the clock, not the row");
}

console.log("3. the owner's list is readable and carries no ids:");
{
  const holdings = await ownerLiveGrants(ORG, OWNER_KEY, NOW + 1_000);
  const text = ownerGrantListText(holdings);
  ok(text.includes("1. Read a Notion page"), "the list names what each grant DOES, in the reviewed phrase — never the vendor's tool id");
  ok(text.includes('They asked for it to "draft the Q3 summary"'), "…and the purpose the owner read when they approved it, as quoted data");
  ok(text.includes("Say which number to end"), "…and says how to end one");
  for (const { name, re } of GRANT_ID_LEAK_PATTERNS) ok(!re.test(text), `…and carries no ${name}`);
  const first = holdings[0];
  ok(!text.includes(first.grant.expiresAt), "the raw `expires_at` column value is NOT printed");
  ok(!text.includes(first.grant.id), "…nor the grant's own id: the owner names a NUMBER, never an id");
  ok(
    /for the next \d+ (minute|hour|day)s? \(until (\d{1,2} \w{3}, )?\d{2}:\d{2} UTC\)/u.test(text),
    "…and the expiry reads as a span and a clock time, which is what an owner is deciding about",
  );
  const none = ownerGrantListText([]);
  eq(
    none,
    "I can see nothing you are lending from the account you are messaging me with. If you approved a grant from a different account, ask me there.",
    "…and holding none reads as the ordinary state, never as a failure",
  );
  ok(none.includes("from the account you are messaging me with"), "…scoped to the account that was actually queried, so it cannot state a deployment-wide fact it never checked");
}

console.log("4. the OWNER's DM call ends the grant, tells the room, and the broker then refuses:");
{
  const before = await ownerLiveGrants(ORG, OWNER_KEY, NOW + 1_000);
  const ordinal = before.findIndex((h) => h.grant.id === grantA) + 1;
  ok(ordinal > 0, "fixture: grant A is on the owner's live list");
  const postsBefore = posted.length;
  const listed = await callTool(dmCtx("U-owner"), { action: "list" });
  eq(listed.grants.map((g) => g.number), before.map((h) => h.ordinal), "the listing's machine half numbers the same rows the message does");
  eq(listed.grants.map((g) => g.id), before.map((h) => h.grant.id), "…and pairs each number with that row's own grant id");
  for (const { name, re } of GRANT_ID_LEAK_PATTERNS) ok(!re.test(listed.message), `NEGATIVE CONTROL: the ids ride in \`grants\`, never in the person's copy — no ${name} in the message`);
  const result = await callTool(dmCtx("U-owner"), { action: "end", grants: [listed.grants[ordinal - 1].id] });

  eq(result.ended, 1, "the tool ended exactly one grant");
  eq((await store.getCredentialGrant(ORG, grantA))?.status, "revoked", "…and the ROW is revoked — the store CAS ran, not just the copy");
  eq((await store.getCredentialGrant(ORG, grantB))?.status, "active", "NEGATIVE CONTROL: the grant the owner did NOT name is untouched — the ordinal selects, it does not sweep");

  ok(result.message.includes("That grant is ended."), "…the owner reads that it ended");
  ok(result.message.includes("Read a Notion page"), "…named in the same words the list used, so a mis-typed number is visible");
  for (const { name, re } of GRANT_ID_LEAK_PATTERNS) ok(!re.test(result.message), `…and the owner's confirmation carries no ${name}`);
  ok(!result.message.includes(grantA), "…nor the grant's own id");
  ok(!result.message.includes("chat-a"), "…nor the SCOPE KEY, which names the borrowing chat and is the id the pattern loop cannot see");

  eq(posted.length, postsBefore + 1, "THE BORROWING ROOM WAS TOLD — one host-authored post, with no model in this tier and nothing else that could author it");
  eq(posted[posted.length - 1].target, { channelId: "C-ROOM", platform: "slack" }, "…into the address the ASK pinned, never a room resolved at revoke time");
  ok(posted[posted.length - 1].text.includes("The owner took back their"), "…saying the owner ended it");
  ok(posted[posted.length - 1].text.includes("every call on it is refused"), "…and telling the seat what its still-mounted tool now does, so the refusal does not read as a fault");
  ok(!posted[posted.length - 1].text.includes("draft the Q3 summary"), "NEGATIVE CONTROL: the room is NOT told the owner's reason — a person's reason for taking their credential back is theirs (§6.2)");
  for (const { name, re } of GRANT_ID_LEAK_PATTERNS) ok(!re.test(posted[posted.length - 1].text), `…and the room notice carries no ${name}`);
  ok(!posted[posted.length - 1].text.includes(grantA), "…nor the grant's own id");
  ok(!posted[posted.length - 1].text.includes("chat-a"), "…nor the scope key of the chat it is addressed to");

  const rows = (await readAudit({ org: ORG, limit: 200 })).filter((r) => r.action === "grant.revoked");
  const row = rows.find((r) => (r.detail as { grantId?: string }).grantId === grantA);
  ok(row !== undefined, "…and ONE `grant.revoked` audit row names the grant");
  eq((row?.detail as { route?: string }).route, "thread", "…recording HOW it was revoked: the owner said so in a conversation");
  eq(row?.principalId, OWNER_KEY, "…and WHO revoked it — the owner's own key, the same one the lookup was made with");

  const postsAfterFirst = posted.length;
  const auditBefore = (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.revoked").length;
  const redelivered = await callTool(dmCtx("U-owner"), { action: "end", grants: [listed.grants[ordinal - 1].id] });
  eq(redelivered.ended, 0, "🔴 THE REDELIVERED `end` ENDS NOTHING — the id names a row that is already revoked, so the live-list lookup does not offer it");
  eq((await store.getCredentialGrant(ORG, grantB))?.status, "active", "🔴 …and grant B, which position 1 now points AT, is untouched: the repeat could not walk onto its neighbour");
  eq(posted.length, postsAfterFirst, "…no second room notice, because nothing was ended to notify about");
  eq(
    (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "grant.revoked").length,
    auditBefore,
    "…and no second `grant.revoked` audit row — the no-op is a real no-op, not a silent re-write",
  );
  ok(redelivered.message.includes("none of what you named is still live"), "…and the owner is told plainly that nothing matched");
  ok(redelivered.message.includes("You still lend"), "…with the FRESH live list reprinted, so they need no second round trip to see what is left");

  const sentBefore = sent.length;
  const refused = await inEveContext(new FakeEveContext(), async () => {
    const ctx = roomCtx("chat-a");
    recordRequesterIdentity(ctx, undefined, ENVELOPE);
    return (await runGrantedCall(grantA, { id: "abc123" }, { ...stamps, nowMs: Date.now(), requesterPrincipalId: "slack/T1/U-req", scopeKey: "chat-a" })) as {
      ok: boolean;
      refused?: string;
    };
  });
  eq(refused.ok ? "OK" : refused.refused, "revoked", "THE BORROWER'S NEXT CALL IS REFUSED `revoked` — the grant is ended, not merely announced");
  eq(sent.length, sentBefore, "…and no vendor request was sent under the owner's credential");
}

console.log("5. NEGATIVE CONTROLS — every way the route must not fire:");
{
  const liveIds = async (): Promise<string[]> => (await ownerLiveGrants(ORG, OWNER_KEY, NOW + 1_000)).map((h) => h.grant.id);
  const before = await liveIds();
  ok(before.includes(grantB), "fixture: grant B is still live for every control below");

  eq(bindFrom(dmCtx("U-owner", { channel: true })).mode, "channel", "fixture: the channel ctx really binds as a channel");
  ok((await refusal(dmCtx("U-owner", { channel: true }), { action: "end", all: true })).includes("DM-only"), "a CHANNEL seat is refused — the DM wall");
  ok((await refusal(dmCtx("U-owner", { attested: true }), { action: "end", all: true })).includes("verified person"), "an UNATTENDED fire is refused — no acting principal, so a routine cannot end its creator's grants");
  ok((await refusal(dmCtx("U-owner"), { action: "end" })).includes("never both and never neither"), "`end` with NEITHER `which` nor `all` is refused — an omitted target must never read as `all`");
  ok((await refusal(dmCtx("U-owner"), { action: "end", all: true, grants: [grantB] })).includes("never both and never neither"), "…and `end` with BOTH is refused too");
  eq(await liveIds(), before, "…and NONE of those four refusals revoked anything");
  const schema = (revokeTool as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema;
  ok(!schema.safeParse({ action: "end", grants: [1] }).success, "`end` carrying the list's NUMBER is refused by the schema — `grants` takes ids, so a position cannot even be expressed");
  ok(schema.safeParse({ action: "end", grants: [grantB] }).success, "NEGATIVE CONTROL: the same call with a grant ID parses, so the refusal above is about the TYPE and not a broken schema");
  const numbered = await callTool(dmCtx("U-owner"), { action: "end", grants: [1] as unknown as string[] });
  eq(numbered.ended, 0, "…and a number that got past the schema still ends nothing — the filter matches row ids, never positions");
  eq(await liveIds(), before, "…so it revoked nothing");
  const foreign = await callTool(dmCtx("U-owner"), { action: "end", grants: ["9f8b4c2e-1d3a-4f6b-8c7d-2e1f0a9b8c7d"] });
  eq(foreign.ended, 0, "an id that names no grant of THIS owner ends nothing — the lookup is owner-keyed, so an id is not a capability");
  eq(await liveIds(), before, "…and this owner's grants are untouched");

  const listed = await callTool(dmCtx("U-owner"), { action: "list" });
  eq(listed.ended, 0, "`list` ends nothing");
  eq(await liveIds(), before, "…and the rows are untouched — a read is a read");

  const stranger = await callTool(dmCtx("U-stranger"), { action: "end", all: true });
  eq(stranger.ended, 0, "a DIFFERENT person's DM ends nothing — the query key is the CALLER's own principal, so there is no id a stranger could name");
  eq(await liveIds(), before, "…and this owner's grants are all still live");

  const missing = await callTool(dmCtx("U-owner"), { action: "end", grants: ["no-such-grant"] });
  eq(missing.ended, 0, "an id that names no live grant ends nothing");
  ok(missing.message.includes("none of what you named is still live"), "…and says so, rather than reporting a silent success");
  eq(await liveIds(), before, "…and revokes nothing by accident");
}

console.log("6. `all` ends every live grant, and an unreachable room never blocks the revoke:");
{
  const orphan = await mintGrant({ pageId: "ghi789", scopeKey: "chat-orphan", target: false });
  const before = (await ownerLiveGrants(ORG, OWNER_KEY, NOW + 1_000)).map((h) => h.grant.id);
  ok(before.includes(orphan) && before.includes(grantB), "fixture: both the orphan and grant B are live");
  const postsBefore = posted.length;

  const outcome = await revokeOwnerGrants(stamps, OWNER_KEY, undefined, NOW + 2_000);
  eq(outcome.ended.length, before.length, "`all` ended every live grant this owner held");
  eq(outcome.remaining.length, 0, "…and the owner lends nothing afterwards");
  eq((await store.getCredentialGrant(ORG, orphan))?.status, "revoked", "…including the one whose room could not be told");
  eq(outcome.notices.filter((x) => x === "no_target").length, 1, "…and that one is reported `no_target`, not `sent` — an unpostable ask is an honest absence, never a guessed room");
  ok(outcome.notices.includes("sent"), "NEGATIVE CONTROL: the reachable rooms WERE posted to, so `no_target` is a per-row answer rather than a broken arm");
  eq(posted.length, postsBefore + outcome.notices.filter((x) => x === "sent").length, "…and exactly one post per `sent` row");
  ok(outcome.text.includes("You are not lending your account to anything now."), "…and the owner reads that nothing is left");
  ok(!outcome.text.includes("has been told"), "🔴 the owner is NOT told every room heard, because one of them did not");
  ok(outcome.text.includes("I told the conversations I could reach and marked the rest below."), "…the mixed outcome is stated plainly");
  ok(outcome.text.includes("— not told, I could not reach that conversation"), "…and the unreachable grant is marked on its OWN line, so the owner knows WHICH borrower is still ignorant");
  eq(
    (outcome.text.match(/— not told, I could not reach that conversation/gu) ?? []).length,
    1,
    "…exactly one line is marked: the reachable rooms are not smeared with the orphan's failure",
  );
}

console.log("6b. ending one grant renumbers the rest, and the answer prints the new numbering:");
{
  const one = await mintGrant({ pageId: "seq-1", purpose: "the first", scopeKey: "chat-seq-1" });
  const two = await mintGrant({ pageId: "seq-2", purpose: "the second", scopeKey: "chat-seq-2" });
  const three = await mintGrant({ pageId: "seq-3", purpose: "the third", scopeKey: "chat-seq-3" });
  eq((await ownerLiveGrants(ORG, OWNER_KEY, NOW + 3_000)).map((h) => h.grant.id), [one, two, three], "fixture: three grants, numbered 1, 2, 3 oldest first");

  const first = await callTool(dmCtx("U-owner"), { action: "end", grants: [await idForNumber(dmCtx("U-owner"), 1)] });
  eq(first.ended, 1, "ending number 1 ends one grant");
  eq((await store.getCredentialGrant(ORG, one))?.status, "revoked", "…and it is the grant that WAS number 1");

  ok(first.message.includes("These numbers are NEW"), "…and the confirmation warns that the remaining numbers changed");
  ok(first.message.includes("has been told"), "…and a room that WAS reached is reported as told, plainly");
  ok(!first.message.includes("not told"), "…with no unreachable-room marking on a call where every room was reached");
  ok(first.message.includes('1. Read a Notion page, ') && first.message.includes("the second"), "…printing the remaining grants NUMBERED, so the next `end` has a live list to read");
  eq(first.grants.map((g) => g.id), [two, three], "…and the machine half is REBUILT from what is left, so the next `end` cannot spend an id for a grant that is gone");
  eq(first.grants.map((g) => g.number), [1, 2], "…renumbered to match the message the person is reading");
  eq((await ownerLiveGrants(ORG, OWNER_KEY, NOW + 3_000)).map((h) => h.grant.id), [two, three], "…and the live list really did shift up by one");

  const second = await callTool(dmCtx("U-owner"), { action: "end", grants: [first.grants[1].id] });
  eq(second.ended, 1, "a second `end` on the number the fresh list calls 2 ends one grant");
  eq((await store.getCredentialGrant(ORG, three))?.status, "revoked", "…and it is the third grant, which the refreshed numbering calls 2");
  eq((await store.getCredentialGrant(ORG, two))?.status, "active", "NEGATIVE CONTROL: the grant now numbered 1 is untouched, so the number really was read against the CURRENT list");
  await revokeOwnerGrants(stamps, OWNER_KEY, undefined, NOW + 3_000);
}

console.log("7. the room notice really varies with the grant it describes:");
{
  const reviewed = grantRevokedRoomText("notion", VENDOR_TOOL);
  const floor = grantRevokedRoomText("notion", "notion-search");
  ok(reviewed.includes("read a Notion page"), "a reviewed (connector, tool) pair renders its reviewed phrase");
  ok(floor.includes("read one thing in Notion"), "…and an unreviewed one falls to the generic floor rather than printing the vendor's tool id");
  ok(reviewed !== floor, "NEGATIVE CONTROL: the two really differ — the copy is a function of its arguments, not one fixed sentence");
  ok(
    reviewed.includes("The tool may still show, but every call on it is refused"),
    "…and it states the honest fact about the mount: the tool stays and the calls are refused, because the mount projects EXISTENCE and the broker refuses on STATE",
  );
}

console.log(`\n✓ credential-grant-revoke: ${String(n)} assertions passed`);

// proves: TOOL-revoke_credential_grant
