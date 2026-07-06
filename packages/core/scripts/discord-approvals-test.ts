
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import type { PendingActionRow } from "../agent/approvals/types.js";

const dir = join(tmpdir(), `open-everywhere-discord-approvals-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.DISCORD_BOT_TOKEN;
delete process.env.DISCORD_PUBLIC_KEY;

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { requestApproval, resolveApprovalClick } = await import("../agent/approvals/flow.js");
const { registerActionKind } = await import("../agent/approvals/actions.js");
const { effectiveCaps } = await import("../agent/spend/caps.js");
const {
  OE_DISCORD_APPROVAL_PREFIX,
  DISCORD_CUSTOM_ID_MAX,
  buildDiscordApprovalCustomId,
  parseDiscordApprovalCustomId,
  pendingDiscordCard,
  decidedDiscordCard,
  isGuildAdministrator,
  scopeWithinGuild,
} = await import("../agent/approvals/discord-card.js");
const { postDiscordApprovalCard, parseDiscordComponentClick, discordResponseFor, handleDiscordApprovalInteraction } = await import(
  "../agent/approvals/discord-flow.js"
);
const { guildIdFromScopeKey, isGuildAdminViaRest } = await import("../agent/approvals/discord-admin.js");
const {
  PUBLIC_DISCORD_ROUTE,
  INTERNAL_DISCORD_ROUTE,
  verifyDiscordInteraction,
  classifyDiscordInteraction,
  buildDiscordFrontHandler,
  frontDiscordChannel,
} = await import("../agent/channels/discord-front.js");
const { POST } = await import("eve/channels");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "org", match: "org", admins: ["U_ORG_ADMIN"] }),
    defineDomain({ name: "eng", channels: ["discord/G1/C_ENG"], admins: ["U_ENG_ADMIN"] }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

let memberExecuted: string[] = [];
registerActionKind({
  kind: "test.member.discord",
  policy: "member",
  summarize: () => ["a member-policy test action"],
  async execute(_args: unknown, decidedBy: string) {
    memberExecuted.push(decidedBy);
    return `executed by ${decidedBy}`;
  },
});

function row(over: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    org: "default",
    kind: "spend.set",
    argsJson: JSON.stringify({ org: "default", scopeKey: "discord/G1/C_ENG", level: "surface", monthlyTokens: 1000, currentCap: null }),
    scopeKey: "discord/G1/C_ENG",
    domain: null,
    requestedBy: "U_REQUESTER",
    channelId: "C_ENG",
    threadTs: null,
    messageTs: "900001",
    status: "pending",
    createdAt: "2026-07-06T00:00:00Z",
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    ...over,
  } as PendingActionRow;
}

function clickPayload(
  customId: string,
  opts: { user?: string; permissions?: string; guild?: string | null; noMember?: boolean } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: 3,
    data: { custom_id: customId, component_type: 2 },
    message: { id: "900001" },
    channel_id: "C_ENG",
  };
  if (opts.guild !== null) base.guild_id = opts.guild ?? "G1";
  if (!opts.noMember) {
    base.member = {
      user: { id: opts.user ?? "U_GUILD_ADMIN", username: "clicker" },
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
    };
  }
  return base;
}

{
  const r = row();
  const approveId = buildDiscordApprovalCustomId(r, "approve");
  const rejectId = buildDiscordApprovalCustomId(r, "reject");
  ok(approveId === `${OE_DISCORD_APPROVAL_PREFIX}${r.id}:approve:default`, "custom_id is prefix:id:verb:org");
  ok(approveId.length <= DISCORD_CUSTOM_ID_MAX, `a uuid-id + "default"-org custom_id fits Discord's ${DISCORD_CUSTOM_ID_MAX}-char cap (${approveId.length})`);
  ok(
    JSON.stringify(parseDiscordApprovalCustomId(approveId)) === JSON.stringify({ id: r.id, decision: "approve", org: "default" }),
    "parse round-trips the approve custom_id",
  );
  ok(parseDiscordApprovalCustomId(rejectId)?.decision === "reject", "parse round-trips the reject custom_id");
  ok(parseDiscordApprovalCustomId("eve_input:something") === null, "rejects a foreign prefix (eve's HITL buttons)");
  ok(parseDiscordApprovalCustomId("oe-approval:id-only") === null, "rejects a missing verb/org");
  ok(parseDiscordApprovalCustomId("oe-approval:id:maybe:org") === null, "rejects an unrecognised decision segment");
  ok(parseDiscordApprovalCustomId("oe-approval:id:approve:") === null, "rejects an empty org");
  ok(parseDiscordApprovalCustomId("oe-approval::approve:org") === null, "rejects an empty id");
  const weird = parseDiscordApprovalCustomId("oe-approval:the-id:approve:org:with:colons");
  ok(weird?.org === "org:with:colons" && weird?.id === "the-id", "an org containing colons survives the round-trip");

  const longOrg = row({ org: "x".repeat(80) });
  assert.throws(() => buildDiscordApprovalCustomId(longOrg, "approve"), /100/);
  n++;
  assert.throws(() => pendingDiscordCard(longOrg, ["line"]), /100/);
  n++;
}

{
  const r = row();
  const card = pendingDiscordCard(r, ["line one", "line two"]);
  ok(card.content.includes("**Approval requested: spend.set**"), "pending card leads with the kind header");
  ok(card.content.includes("line one") && card.content.includes("line two"), "pending card carries the summary lines");
  ok(card.content.includes(`<@${r.requestedBy}>`), "pending card @-mentions the requester");
  ok(card.content.includes(`expires ${r.expiresAt}`), "pending card shows the expiry timestamp");
  ok(card.content.length < 2000, "pending card content is under Discord's 2000-char message cap");
  ok(card.components.length === 1 && card.components[0].type === 1, "pending card has ONE action row");
  const buttons = (card.components[0] as unknown as { components: { type: number; style: number; label: string; custom_id: string }[] }).components;
  ok(buttons.length === 2 && buttons.every((b) => b.type === 2), "the action row holds two buttons");
  ok(buttons[0].label === "Approve" && buttons[0].style === 3, "Approve is a green (success) button");
  ok(buttons[1].label === "Reject" && buttons[1].style === 4, "Reject is a red (danger) button");
  ok(
    buttons.every((b) => parseDiscordApprovalCustomId(b.custom_id) !== null),
    "both button custom_ids round-trip through the parser",
  );
  ok(
    buttons.every((b) => parseDiscordApprovalCustomId(b.custom_id)?.org === "default"),
    "both buttons carry the org in their custom_id (Discord's `value`-slot analogue)",
  );

  const approved = decidedDiscordCard({ ...r, status: "approved", decidedBy: "U_ORG_ADMIN" }, ["line one"], "spend limit set");
  ok(approved.components.length === 0, "decided card has NO components (buttons stripped — the UX half; CAS is the correctness half)");
  ok(approved.content.includes("✅ Approved by <@U_ORG_ADMIN> · spend limit set"), "decided card renders the approved line + outcome");
  const rejected = decidedDiscordCard({ ...r, status: "rejected", decidedBy: "U_ORG_ADMIN" }, ["line one"], "rejected");
  ok(rejected.content.includes("❌ Rejected by <@U_ORG_ADMIN>"), "decided card renders the rejected line");
  const expired = decidedDiscordCard({ ...r, status: "expired", decidedBy: "system" }, ["line one"], "expired");
  ok(expired.content.includes("⏰ Expired"), "decided card renders the expired line");
}

{
  ok(isGuildAdministrator("8") === true, "permissions '8' (exactly ADMINISTRATOR) is admin");
  ok(isGuildAdministrator("9") === true, "ADMINISTRATOR plus other bits is admin");
  ok(isGuildAdministrator(String((1n << 40n) | 8n)) === true, "a >32-bit field with the 0x8 bit set is admin (BigInt, not Number)");
  ok(isGuildAdministrator("0") === false, "permissions '0' is not admin");
  ok(isGuildAdministrator("4") === false, "other bits without 0x8 are not admin");
  ok(isGuildAdministrator(String(~8n & ((1n << 50n) - 1n))) === false, "every-bit-but-ADMINISTRATOR is not admin");
  ok(isGuildAdministrator(undefined) === false, "FAIL-CLOSED: missing permissions is not admin");
  ok(isGuildAdministrator("") === false, "FAIL-CLOSED: empty permissions is not admin");
  ok(isGuildAdministrator("abc") === false, "FAIL-CLOSED: non-numeric permissions is not admin");
  ok(isGuildAdministrator("-8") === false, "FAIL-CLOSED: a negative field is not admin");
  ok(isGuildAdministrator("8.5") === false, "FAIL-CLOSED: a decimal field is not admin");
  ok(isGuildAdministrator(8) === false, "FAIL-CLOSED: a NUMBER (non-string) field is not admin — Discord sends strings");
}

{
  ok(scopeWithinGuild("discord/G1/C_ENG", "G1") === true, "a surface scope inside the guild is within it");
  ok(scopeWithinGuild("discord/G1", "G1") === true, "the guild's own workspace scope is within it");
  ok(scopeWithinGuild("discord/G2/C_X", "G1") === false, "another guild's scope is NOT within it");
  ok(scopeWithinGuild("discord/G11/C_X", "G1") === false, "segment-exact: guild G11 is not guild G1");
  ok(scopeWithinGuild("slack/T1/C1", "G1") === false, "a Slack scope is never within a Discord guild");
  ok(scopeWithinGuild("discord/G1/C_ENG", undefined) === false, "FAIL-CLOSED: no guild id on the click → no guild standing");
}

{
  ok(classifyDiscordInteraction(JSON.stringify({ type: 1 })).kind === "forward", "PING forwards (eve answers PONG)");
  ok(classifyDiscordInteraction(JSON.stringify({ type: 2, data: { name: "oe" } })).kind === "forward", "a slash command forwards");
  ok(classifyDiscordInteraction(JSON.stringify({ type: 5, data: { custom_id: "eve_input:x" } })).kind === "forward", "a modal submit forwards");
  ok(
    classifyDiscordInteraction(JSON.stringify({ type: 3, data: { custom_id: "eve_input:abc" } })).kind === "forward",
    "eve's own HITL component click forwards",
  );
  const ours = classifyDiscordInteraction(JSON.stringify(clickPayload("oe-approval:id:approve:default")));
  ok(ours.kind === "approval-click", "an oe-approval component click is OURS");
  ok(classifyDiscordInteraction("not json at all").kind === "forward", "unparseable body forwards (eve acks it)");
  ok(classifyDiscordInteraction("42").kind === "forward", "a non-object body forwards");
  ok(classifyDiscordInteraction(JSON.stringify({ type: 3 })).kind === "forward", "a component click with no data/custom_id forwards");
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubHex = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
const signedHeaders = (body: string, timestamp: string): Headers =>
  new Headers({
    "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
    "x-signature-timestamp": timestamp,
  });
{
  const body = JSON.stringify({ type: 1 });
  const ts = String(Math.floor(Date.now() / 1000));
  ok(verifyDiscordInteraction(body, signedHeaders(body, ts), pubHex) === true, "a correctly signed request verifies");
  ok(verifyDiscordInteraction(body + "tamper", signedHeaders(body, ts), pubHex) === false, "a tampered body fails");
  ok(verifyDiscordInteraction(body, signedHeaders(body, ts), "aa".repeat(32)) === false, "the wrong public key fails");
  ok(verifyDiscordInteraction(body, signedHeaders(body, ts), undefined) === false, "FAIL-CLOSED: no public key configured → never verified");
  ok(verifyDiscordInteraction(body, new Headers(), pubHex) === false, "missing signature headers fail");
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  ok(verifyDiscordInteraction(body, signedHeaders(body, stale), pubHex) === false, "a stale timestamp (outside the 5-min window) fails");
  ok(verifyDiscordInteraction(body, signedHeaders(body, ts), pubHex, Date.now() + 3600_000) === false, "the skew window is symmetric (future-dated check clock)");
}

{
  const captured: { row: PendingActionRow; summaryLines: readonly string[] }[] = [];
  const postCard = async (r: PendingActionRow, summaryLines: readonly string[]) => {
    captured.push({ row: r, summaryLines });
    return "dmsg-777";
  };
  const { id } = await requestApproval(
    {
      org: "default",
      kind: "spend.set",
      args: { org: "default", scopeKey: "discord/G1/C_ENG", level: "surface", monthlyTokens: 750, currentCap: null },
      scopeKey: "discord/G1/C_ENG",
      requestedBy: "U_REQUESTER",
      channelId: "C_ENG",
    },
    { postCard },
  );
  ok(captured.length === 1 && captured[0].row.id === id, "the injected CardPoster receives the frozen pending row");
  ok(captured[0].summaryLines.some((l) => l.includes("discord/G1/C_ENG")), "the poster receives the code-rendered summary lines");
  const posted = await getOperationalStore().getPendingAction("default", id);
  ok(posted?.messageTs === "dmsg-777", "the poster's message id lands as the row's messageTs");
  const audit = await readAudit({ org: "default", action: "approval.requested" });
  ok(audit.some((e) => e.detail?.id === id && e.platform === "discord"), "approval.requested audits with the discord platform from the scopeKey");

  let threw = false;
  try {
    await requestApproval(
      {
        org: "default",
        kind: "spend.set",
        args: { org: "default", scopeKey: "discord/G1/C_FAIL", level: "surface", monthlyTokens: 1, currentCap: null },
        scopeKey: "discord/G1/C_FAIL",
        requestedBy: "U_REQUESTER",
        channelId: "C_FAIL",
      },
      { postCard: async () => undefined },
    );
  } catch (err) {
    threw = true;
    ok(/failed to post/.test(String(err)), "a failed CardPoster throws the explanatory error");
  }
  ok(threw, "requestApproval throws when the Discord card never posts (a pending nobody can see must not linger)");
}

{
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchOk = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ id: "dmsg-1" }) };
  }) as unknown as typeof fetch;
  const id = await postDiscordApprovalCard(row(), ["line one"], { token: "test-token", fetchFn: fetchOk });
  ok(id === "dmsg-1", "poster resolves the created message's id");
  ok(calls[0].url.includes("/channels/C_ENG/messages"), "poster targets the pending row's own channel");
  const sent = JSON.parse(String(calls[0].init.body)) as { content: string; components: unknown[] };
  ok(sent.components.length === 1 && sent.content.includes("Approval requested"), "poster sends the rendered content + components");
  ok((calls[0].init.headers as Record<string, string>).authorization === "Bot test-token", "poster authenticates with the bot token header");

  const fetchFail = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
  ok((await postDiscordApprovalCard(row(), ["l"], { token: "t", fetchFn: fetchFail })) === undefined, "a non-ok status resolves undefined (never throws)");
  ok((await postDiscordApprovalCard(row(), ["l"], { fetchFn: fetchOk })) === undefined, "no bot token resolves undefined (fail-soft)");
  const fetchThrows = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  ok((await postDiscordApprovalCard(row(), ["l"], { token: "t", fetchFn: fetchThrows })) === undefined, "a network error resolves undefined (never throws)");
  ok(
    (await postDiscordApprovalCard(row({ org: "x".repeat(80) }), ["l"], { token: "t", fetchFn: fetchOk })) === undefined,
    "an over-cap custom_id fails the post softly (render throws, poster catches)",
  );
}

{
  ok(parseDiscordComponentClick(null) === null, "null payload → not ours");
  ok(parseDiscordComponentClick({ type: 2 }) === null, "a command interaction → not ours");
  ok(parseDiscordComponentClick({ type: 3, data: { custom_id: "eve_input:x" } }) === null, "eve's HITL click → not ours");
  const parsed = parseDiscordComponentClick(clickPayload("oe-approval:id:approve:default", { user: "U1", permissions: "8" }));
  ok(parsed?.clickerId === "U1" && parsed?.memberPermissions === "8" && parsed?.guildId === "G1", "probes clicker/permissions/guild from a guild click");
  const dm = parseDiscordComponentClick({ type: 3, data: { custom_id: "oe-approval:id:approve:default" }, user: { id: "U_DM" } });
  ok(dm?.clickerId === "U_DM" && dm?.guildId === undefined, "a DM click resolves the top-level user (no member envelope)");
  const anonymous = parseDiscordComponentClick(clickPayload("oe-approval:id:approve:default", { noMember: true }));
  ok(anonymous !== null && anonymous.clickerId === undefined, "an ours-prefixed click with no user still parses (handler fails soft ON it, never forwards)");
}

{
  ok((discordResponseFor({ outcome: "not-pending" }) as { type: number }).type === 6, "not-pending → deferred update (silent ack, message untouched)");
  ok((discordResponseFor({ outcome: "lost-race" }) as { type: number }).type === 6, "lost-race → deferred update");
  ok((discordResponseFor({ outcome: "expired-race" }) as { type: number }).type === 6, "expired-race → deferred update");
  ok((discordResponseFor({ outcome: "unregistered-kind" }) as { type: number }).type === 6, "unregistered-kind → deferred update");
  const unknown = discordResponseFor({ outcome: "unknown" }) as { type: number; data: { flags: number } };
  ok(unknown.type === 4 && unknown.data.flags === 64, "unknown → ephemeral note (type 4, flags 64)");
}

type Resp = { type: number; data?: { content?: string; components?: unknown[]; flags?: number } };
const store = getOperationalStore();

{
  ok((await handleDiscordApprovalInteraction({ type: 2 })) === null, "a command interaction returns null (forward)");
  ok((await handleDiscordApprovalInteraction(clickPayload("eve_input:abc"))) === null, "eve's HITL click returns null (forward)");
  ok(
    (await handleDiscordApprovalInteraction(clickPayload("oe-approval:garbage-no-verb"))) === null,
    "an ours-prefixed but unparseable custom_id returns null (forward — eve's HITL decode no-ops it)",
  );
}

{
  await store.addPendingAction(row({ id: "dp-nouser" }));
  const res = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:dp-nouser:approve:default", { noMember: true }))) as Resp;
  ok(res.type === 4 && res.data?.flags === 64, "a click with no readable user answers an ephemeral note");
  ok((await store.getPendingAction("default", "dp-nouser"))?.status === "pending", "…and the decision is NOT applied");
}

{
  await store.addPendingAction(
    row({ id: "dp-happy", argsJson: JSON.stringify({ org: "default", scopeKey: "discord/G1/C_ENG", level: "surface", monthlyTokens: 500, currentCap: null }) }),
  );
  const res = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:dp-happy:approve:default", { user: "U_GUILD_ADMIN", permissions: "8" }))) as Resp;
  ok(res.type === 7, "guild-admin approve answers UPDATE_MESSAGE (type 7) — the card itself becomes the decided card");
  ok(res.data?.components?.length === 0, "…with the buttons stripped");
  ok(String(res.data?.content).includes("✅ Approved by <@U_GUILD_ADMIN>"), "…and the approved-by line");
  const decided = await store.getPendingAction("default", "dp-happy");
  ok(decided?.status === "approved" && decided?.decidedBy === "U_GUILD_ADMIN", "the row is CAS-decided by the guild admin");
  const caps = await effectiveCaps("default", "discord/G1", "discord/G1/C_ENG");
  ok(caps.surfaceMonthlyTokens === 500, "the frozen mutation actually EXECUTED (same executor as Slack/control-plane)");
  const audit = await readAudit({ org: "default", action: "approval.approved" });
  ok(audit.some((e) => e.detail?.id === "dp-happy" && e.principalId === "U_GUILD_ADMIN"), "audits approval.approved with the clicker as principal");
  await store.clearSpendLimit("default", "discord/G1/C_ENG", "surface");

  const stale = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:dp-happy:approve:default", { user: "U_GUILD_ADMIN", permissions: "8" }))) as Resp;
  ok(stale.type === 6, "a re-click on a decided card answers a silent deferred ack");
}

{
  await store.addPendingAction(row({ id: "dp-denied" }));
  const cases: [string, Record<string, unknown>][] = [
    ["a plain member (permissions '0')", clickPayload("oe-approval:dp-denied:approve:default", { user: "U_RANDO", permissions: "0" })],
    ["missing permissions entirely", clickPayload("oe-approval:dp-denied:approve:default", { user: "U_RANDO" })],
    ["malformed permissions", clickPayload("oe-approval:dp-denied:approve:default", { user: "U_RANDO", permissions: "not-a-bitfield" })],
    ["an ADMINISTRATOR of a DIFFERENT guild", clickPayload("oe-approval:dp-denied:approve:default", { user: "U_OTHER_ADMIN", permissions: "8", guild: "G2" })],
  ];
  for (const [label, payload] of cases) {
    const res = (await handleDiscordApprovalInteraction(payload)) as Resp;
    ok(res.type === 4 && res.data?.flags === 64, `${label} → ephemeral rejection (flags 64)`);
    ok((await store.getPendingAction("default", "dp-denied"))?.status === "pending", `${label} → the row stays PENDING (not consumed)`);
  }

  await store.addPendingAction(row({ id: "dp-roster", domain: "eng" }));
  const roster = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:dp-roster:approve:default", { user: "U_ENG_ADMIN", permissions: "0" }))) as Resp;
  ok(roster.type === 7, "the frozen domain's config-roster admin may decide without guild ADMINISTRATOR");
  ok((await store.getPendingAction("default", "dp-roster"))?.decidedBy === "U_ENG_ADMIN", "…and the row records them");
  await store.addPendingAction(row({ id: "dp-org" }));
  const orgClick = { type: 3, data: { custom_id: "oe-approval:dp-org:approve:default" }, user: { id: "U_ORG_ADMIN" } };
  const orgRes = (await handleDiscordApprovalInteraction(orgClick)) as Resp;
  ok(orgRes.type === 7, "an org admin may decide from a DM click (config roster, no guild context)");
  await store.clearSpendLimit("default", "discord/G1/C_ENG", "surface");
}

{
  await store.addPendingAction(row({ id: "dp-reject" }));
  const res = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:dp-reject:reject:default", { user: "U_GUILD_ADMIN", permissions: "8" }))) as Resp;
  ok(res.type === 7 && String(res.data?.content).includes("❌ Rejected by <@U_GUILD_ADMIN>"), "reject answers the rejected card");
  ok((await store.getPendingAction("default", "dp-reject"))?.status === "rejected", "the row is rejected");
  const audit = await readAudit({ org: "default", action: "approval.rejected" });
  ok(audit.some((e) => e.detail?.id === "dp-reject"), "audits approval.rejected");
}

{
  await store.addPendingAction(row({ id: "dp-expired", expiresAt: "2000-01-01T00:00:00Z" }));
  const res = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:dp-expired:approve:default", { user: "U_GUILD_ADMIN", permissions: "8" }))) as Resp;
  ok(res.type === 7 && String(res.data?.content).includes("⏰ Expired"), "a click on an aged-out pending answers the expired card");
  const after = await store.getPendingAction("default", "dp-expired");
  ok(after?.status === "expired" && after?.decidedBy === "system", "…and CAS-expires the row");
}

{
  await store.addPendingAction(row({ id: "dp-member", kind: "test.member.discord", argsJson: "{}", domain: null }));
  memberExecuted = [];
  const res = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:dp-member:approve:default", { user: "U_ANYONE", permissions: "0" }))) as Resp;
  ok(res.type === 7, "a member-policy kind decides for ANY clicker");
  ok(memberExecuted.includes("U_ANYONE"), "…and executes with the clicker as decidedBy");
}

{
  const res = (await handleDiscordApprovalInteraction(clickPayload("oe-approval:no-such-row:approve:default", { user: "U_GUILD_ADMIN", permissions: "8" }))) as Resp;
  ok(res.type === 4 && String(res.data?.content).includes("no longer known"), "an unknown pending id answers the not-known ephemeral note");
}

{
  await store.addPendingAction(row({ id: "dp-or", domain: null }));
  const res = await resolveApprovalClick({ org: "default", id: "dp-or", decision: "reject", clickerId: "U_ORG_ADMIN" });
  ok(res.outcome === "decided", "the core decides for a roster admin with NO platformAdmin predicate at all (Slack call shape)");
}

{
  let innerCalls = 0;
  let innerSawBody = "";
  const innerHandler = async (req: Request) => {
    innerCalls++;
    innerSawBody = await req.text();
    return new Response("inner-ok", { status: 200 });
  };

  const front = buildDiscordFrontHandler(innerHandler as never, { publicKey: pubHex });
  const post = (body: string, headers: Headers) =>
    front(new Request(`https://x.example${PUBLIC_DISCORD_ROUTE}`, { method: "POST", headers, body }), {} as never);

  const unsigned = await post(JSON.stringify({ type: 1 }), new Headers());
  ok(unsigned.status === 401 && innerCalls === 0, "an unsigned request is 401'd fail-closed, never forwarded");

  const ping = JSON.stringify({ type: 1 });
  const pingRes = await post(ping, signedHeaders(ping, String(Math.floor(Date.now() / 1000))));
  ok((await pingRes.text()) === "inner-ok" && innerCalls === 1, "a signed PING forwards to discordChannel's own handler");
  ok(innerSawBody === ping, "the forwarded Request carries the same raw body (eve re-verifies over it)");

  await store.addPendingAction(row({ id: "dp-front" }));
  const click = JSON.stringify(clickPayload("oe-approval:dp-front:approve:default", { user: "U_GUILD_ADMIN", permissions: "8" }));
  const clickRes = await post(click, signedHeaders(click, String(Math.floor(Date.now() / 1000))));
  ok(clickRes.headers.get("content-type") === "application/json", "our click is answered as an interaction-response JSON");
  const clickBody = (await clickRes.json()) as Resp;
  ok(clickBody.type === 7 && innerCalls === 1, "…a type-7 UPDATE_MESSAGE, without ever touching eve's handler");
  ok((await store.getPendingAction("default", "dp-front"))?.status === "approved", "…and the decide really happened through the front");
  await store.clearSpendLimit("default", "discord/G1/C_ENG", "surface");

  const hitl = JSON.stringify({ type: 3, data: { custom_id: "eve_input:abc" }, message: { id: "m1" } });
  await post(hitl, signedHeaders(hitl, String(Math.floor(Date.now() / 1000))));
  ok(innerCalls === 2, "eve's own HITL component click forwards untouched");

  const innerChannel = { routes: [POST(INTERNAL_DISCORD_ROUTE, innerHandler as never)], kindHint: "discord" } as never;
  const fronted = frontDiscordChannel(innerChannel, { publicKey: pubHex }) as unknown as { routes: { path: string }[]; kindHint: string };
  ok(fronted.routes[0].path === PUBLIC_DISCORD_ROUTE, "frontDiscordChannel prepends the public front route");
  ok(fronted.routes.some((r) => r.path === INTERNAL_DISCORD_ROUTE), "…and keeps the wrapped channel's internal route");
  ok(fronted.kindHint === "discord", "…preserving the rest of the channel value");
  assert.throws(
    () => frontDiscordChannel({ routes: [POST("/somewhere/else", innerHandler as never)] } as never),
    /must be built with route/,
    "frontDiscordChannel refuses an inner channel not mounted on the internal route",
  );
  n++;
}

{
  ok(guildIdFromScopeKey("discord/G1") === "G1", "guildIdFromScopeKey parses a workspace key");
  ok(guildIdFromScopeKey("discord/G1/C2") === "G1", "guildIdFromScopeKey parses a surface key");
  ok(guildIdFromScopeKey("slack/T1/C2") === undefined, "guildIdFromScopeKey rejects other platforms");
  ok(guildIdFromScopeKey("discord/") === undefined, "guildIdFromScopeKey rejects an empty guild segment");
  ok(guildIdFromScopeKey("discord") === undefined, "guildIdFromScopeKey rejects a bare platform");
}

{
  const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const restFetch =
    (guild: unknown, member: unknown, memberStatus = 200) =>
    (async (url: string | URL) => {
      const u = String(url);
      if (/\/guilds\/[^/]+$/.test(u)) return jsonRes(guild === undefined ? 404 : 200, guild ?? {});
      if (/\/members\//.test(u)) return jsonRes(memberStatus, member ?? {});
      throw new Error(`unexpected REST url ${u}`);
    }) as typeof fetch;

  const adminRole = { id: "r-admin", permissions: "8" };
  const plainRole = { id: "r-plain", permissions: "104324673" };

  ok(
    (await isGuildAdminViaRest("Ga", "U-owner", { token: "t", fetchFn: restFetch({ owner_id: "U-owner", roles: [] }, undefined) })) === true,
    "guild OWNER is admin (no member call needed)",
  );
  ok(
    (await isGuildAdminViaRest("Gb", "U-roled", { token: "t", fetchFn: restFetch({ owner_id: "X", roles: [adminRole, plainRole] }, { roles: ["r-plain", "r-admin"] }) })) === true,
    "a member holding an ADMINISTRATOR role is admin",
  );
  ok(
    (await isGuildAdminViaRest("Gc", "U-plain", { token: "t", fetchFn: restFetch({ owner_id: "X", roles: [adminRole, plainRole] }, { roles: ["r-plain"] }) })) === false,
    "a member with only non-admin roles is not",
  );
  ok(
    (await isGuildAdminViaRest("Gd", "U-out", { token: "t", fetchFn: restFetch({ owner_id: "X", roles: [adminRole] }, undefined, 404) })) === false,
    "a non-member (member 404) is not admin",
  );
  ok(
    (await isGuildAdminViaRest("Ge", "U-any", { token: "t", fetchFn: restFetch(undefined, undefined) })) === false,
    "FAIL-CLOSED: an unknown guild (404 — e.g. a DM-bucket user id in the guild slot) is not admin",
  );
  ok((await isGuildAdminViaRest("Gf", "U-any", { token: "" })) === false, "FAIL-CLOSED: no bot token is not admin");
  ok(
    (await isGuildAdminViaRest("Gg", "U-any", {
      token: "t",
      fetchFn: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    })) === false,
    "FAIL-CLOSED: a thrown fetch is not admin (never throws out)",
  );
  ok(
    (await isGuildAdminViaRest("Ga", "U-owner", {
      token: "t",
      fetchFn: (async () => {
        throw new Error("should not be called — cached");
      }) as typeof fetch,
    })) === true,
    "verdicts are cached inside the TTL (no second REST round-trip)",
  );
}

console.log(`\n✓ discord-approvals: ${n} assertions passed (card render, custom_id codec, admin bitfield, scope fence, REST admin standing, ed25519 gate, poster, click matrix, front route)\n`);
