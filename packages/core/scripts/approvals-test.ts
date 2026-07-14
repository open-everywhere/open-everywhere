import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { PendingActionRow } from "../agent/approvals/types.js";

const dir = join(tmpdir(), `open-everywhere-approvals-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { parseApprovalAction, requestApproval, handleApprovalPayload, clickerMayDecide, OE_APPROVAL_PREFIX, sweepExpiredPendings } = await import("../agent/approvals/flow.js");
const { pendingCardBlocks, decidedCardBlocks } = await import("../agent/approvals/card.js");
const { registerActionKind, actionKind } = await import("../agent/approvals/actions.js");
const { effectiveCaps } = await import("../agent/spend/caps.js");
const { applyConnectorOverrides } = await import("../agent/access/connector-scope.js");
const { markCardPostedThisTurn, consumeCardPostedThisTurn } = await import("../agent/approvals/card-signal.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

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
    defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], admins: ["U_ENG_ADMIN"] }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

let memberExecuted: string[] = [];
registerActionKind({
  kind: "test.member",
  policy: "member",
  summarize: () => ["a member-policy test action"],
  async execute(_args: unknown, decidedBy: string) {
    memberExecuted.push(decidedBy);
    return `executed by ${decidedBy}`;
  },
});

function row(over: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: "p-1",
    org: "default",
    kind: "spend.set",
    argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 1000, currentCap: null }),
    scopeKey: "slack/T1/C1",
    domain: null,
    requestedBy: "U_REQUESTER",
    channelId: "C1",
    threadTs: null,
    messageTs: "111.222",
    status: "pending",
    createdAt: "2026-07-04T00:00:00Z",
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    ...over,
  } as PendingActionRow;
}

{
  ok(OE_APPROVAL_PREFIX === "oe_approval:", "OE_APPROVAL_PREFIX is the documented literal");
  ok(JSON.stringify(parseApprovalAction("oe_approval:approve:p-1")) === JSON.stringify({ decision: "approve", id: "p-1" }), "parses an approve action_id");
  ok(JSON.stringify(parseApprovalAction("oe_approval:reject:p-1")) === JSON.stringify({ decision: "reject", id: "p-1" }), "parses a reject action_id");
  ok(parseApprovalAction("eve_input:something") === null, "rejects a foreign prefix (Eve's own HITL buttons)");
  ok(parseApprovalAction("oe_approval:maybe:p-1") === null, "rejects an unrecognised decision segment");
  ok(parseApprovalAction("oe_approval:approve:") === null, "rejects a missing id");
  ok(parseApprovalAction("oe_approval:approve") === null, "rejects a missing separator entirely");
  ok(parseApprovalAction("not-ours-at-all") === null, "rejects a string with no colon-structure at all");
}

{
  const r = row();
  const { blocks, text } = pendingCardBlocks(r, ["line one", "line two"]);
  const actionsBlock = blocks.find((b) => b.type === "actions") as unknown as { elements: { action_id: string; value: string }[] } | undefined;
  ok(actionsBlock !== undefined, "pendingCardBlocks includes an actions block");
  const ids = actionsBlock!.elements.map((e) => e.action_id);
  ok(ids.includes(`${OE_APPROVAL_PREFIX}approve:p-1`), "pendingCardBlocks' approve button carries the id-scoped action_id");
  ok(ids.includes(`${OE_APPROVAL_PREFIX}reject:p-1`), "pendingCardBlocks' reject button carries the id-scoped action_id");
  ok(parseApprovalAction(ids[0]) !== null && parseApprovalAction(ids[1]) !== null, "both card action_ids round-trip through parseApprovalAction");
  ok(actionsBlock!.elements.every((e) => e.value === "default"), "both buttons carry the org as their value");
  ok(text.includes("<@U_REQUESTER>") || blocks.some((b) => JSON.stringify(b).includes("<@U_REQUESTER>")), "the requester is @-mentioned somewhere on the card");
  ok(JSON.stringify(blocks).includes(`expires ${r.expiresAt}`), "the card shows the expiry timestamp");

  const decided = decidedCardBlocks({ ...r, status: "approved", decidedBy: "U_ORG_ADMIN" }, ["line one"], "spend limit set");
  ok(!decided.blocks.some((b) => b.type === "actions"), "decidedCardBlocks has NO actions block (buttons are gone once decided)");
  ok(JSON.stringify(decided.blocks).includes("✅ Approved by <@U_ORG_ADMIN>"), "decidedCardBlocks renders the approved context line");
  const rejected = decidedCardBlocks({ ...r, status: "rejected", decidedBy: "U_ORG_ADMIN" }, ["line one"], "n/a");
  ok(JSON.stringify(rejected.blocks).includes("❌ Rejected by <@U_ORG_ADMIN>"), "decidedCardBlocks renders the rejected context line");
  const expired = decidedCardBlocks({ ...r, status: "expired", decidedBy: "system" }, ["line one"], "n/a");
  ok(JSON.stringify(expired.blocks).includes("⏰ Expired"), "decidedCardBlocks renders the expired context line");
}

{
  const store = getOperationalStore();
  ok((await store.getPendingAction("default", "p-store")) === null, "store: unknown id returns null");

  const r = row({ id: "p-store" });
  await store.addPendingAction(r);
  const fetched = await store.getPendingAction("default", "p-store");
  ok(fetched !== null && fetched.status === "pending" && fetched.domain === null, "store: round-trips a freshly-inserted row");
  ok(fetched?.argsJson === r.argsJson, "store: argsJson round-trips byte-for-byte (frozen args)");

  await store.setPendingActionMessage("default", "p-store", "999.111");
  ok((await store.getPendingAction("default", "p-store"))?.messageTs === "999.111", "store: setPendingActionMessage updates messageTs");

  const decidedAt = new Date().toISOString();
  const firstDecide = await store.decidePendingAction("default", "p-store", "approved", "U_ORG_ADMIN", decidedAt);
  ok(firstDecide === true, "store: first decide (CAS) wins");
  const afterDecide = await store.getPendingAction("default", "p-store");
  ok(afterDecide?.status === "approved" && afterDecide?.decidedBy === "U_ORG_ADMIN", "store: decide persists status + decidedBy");

  const secondDecide = await store.decidePendingAction("default", "p-store", "rejected", "U_OTHER", decidedAt);
  ok(secondDecide === false, "store: a second decide on an already-decided row loses the CAS");
  ok((await store.getPendingAction("default", "p-store"))?.status === "approved", "store: the row is unchanged by the losing CAS");

  await store.addPendingAction(row({ id: "p-store", org: "acme" }));
  ok((await store.getPendingAction("acme", "p-store"))?.org === "acme", "store: another org's row with the same id is isolated");
  ok((await store.getPendingAction("default", "p-store"))?.org === "default", "store: the original org's row is untouched by the other org's insert");
}

{
  ok(actionKind("nope-not-registered") === undefined, "actionKind: an unregistered kind returns undefined");
  for (const kind of ["spend.set", "spend.clear", "connector.revoke", "connector.clear"]) {
    const k = actionKind(kind);
    ok(k !== undefined && k.kind === kind && k.policy === "admin", `actionKind: "${kind}" is registered with admin policy`);
  }
  ok(actionKind("test.member")?.policy === "member", "actionKind: the test member-policy kind is registered as expected");

  const spendSetKind = actionKind("spend.set")!;
  const labelled = spendSetKind.summarize({ org: "default", scopeKey: "discord/G1/C1", level: "surface", monthlyUsd: 1, currentCap: null, currentUsd: null, scopeLabel: "#proj-chat" } as never);
  ok(labelled[0] === "Set spend limit — #proj-chat (surface)", "summarize: scopeLabel renders instead of the raw key");
  const raw = spendSetKind.summarize({ org: "default", scopeKey: "discord/G1/C1", level: "surface", monthlyUsd: 1, currentCap: null, currentUsd: null } as never);
  ok(raw[0] === "Set spend limit — scope `discord/G1/C1` (surface)", "summarize: no label → raw scope key (pre-label rows unchanged)");
  const clearKind = actionKind("spend.clear")!;
  const clearLabelled = clearKind.summarize({ org: "default", scopeKey: "discord/G1", level: "workspace", currentCap: null, scopeLabel: "the Acme server" } as never);
  ok(clearLabelled[0] === "Clear spend limit override — the Acme server (workspace)", "summarize: spend.clear renders the label too");
}

{
  const before = await effectiveCaps("default", "slack/T2", "slack/T2/C2");
  ok(before.surfaceMonthlyTokens === undefined, "spend.set: no override yet → config caps (uncapped)");

  const spendSet = actionKind("spend.set")!;
  const args = { org: "default", scopeKey: "slack/T2/C2", level: "surface" as const, monthlyTokens: 2500, reason: "incident budget", currentCap: null };
  const outcome = await spendSet.execute(args, "U_ORG_ADMIN");
  ok(typeof outcome === "string" && outcome.length > 0, "spend.set: execute returns a non-empty outcome line");

  const after = await effectiveCaps("default", "slack/T2", "slack/T2/C2");
  ok(after.surfaceMonthlyTokens === 2500, "spend.set: execute writes the SAME override the control-plane write tool would (effectiveCaps reflects it)");

  const limits = await getOperationalStore().spendLimits("default");
  const row2 = limits.find((l) => l.scopeKey === "slack/T2/C2" && l.level === "surface");
  ok(row2?.setBy === "U_ORG_ADMIN" && row2?.reason === "incident budget", "spend.set: the override row carries setBy=decidedBy + the reason");

  const audit = await readAudit({ org: "default", action: "admin.spend.set_limit" });
  ok(audit.some((e) => e.principalId === "U_ORG_ADMIN" && e.detail?.scopeKey === "slack/T2/C2"), "spend.set: audits admin.spend.set_limit with the acting principal");

  const usdArgs = { org: "default", scopeKey: "slack/T2/C2", level: "surface" as const, monthlyUsd: 42.5, reason: "usd bridge", currentCap: null, currentUsd: null };
  const usdCard = spendSet.summarize(usdArgs);
  ok(usdCard.some((line) => line.includes("$42.50/mo")), "spend.set: the card renders the proposed USD cap");
  ok(!usdCard.some((line) => line.includes("tokens/mo")), "spend.set: a USD-only card shows no token line (only what changes is shown)");
  await spendSet.execute(usdArgs, "U_ORG_ADMIN");
  const afterUsd = await effectiveCaps("default", "slack/T2", "slack/T2/C2");
  ok(afterUsd.surfaceMonthlyUsd === 42.5, "spend.set: a USD-only card execute lands as a USD override (effectiveCaps reflects it)");
  ok(afterUsd.surfaceMonthlyTokens === undefined, "spend.set: the USD-only override replaced the previous row — token component reverts to config");

  await getOperationalStore().clearSpendLimit("default", "slack/T2/C2", "surface");
}

{
  const connectorRevoke = actionKind("connector.revoke")!;
  await connectorRevoke.execute({ org: "default", scopeKey: "slack/T2/C2", connector: "notion", reason: "leaked token" }, "U_ORG_ADMIN");
  const overrides = await getOperationalStore().connectorOverrides("default", "slack/T2/C2");
  ok(overrides.some((o) => o.connector === "notion" && o.granted === false), "connector.revoke: execute persists a denied override");
  ok(!applyConnectorOverrides(["notion"], overrides).includes("notion"), "connector.revoke: the overlay removes a revoked connector");
  const audit = await readAudit({ org: "default", action: "admin.connector.revoke" });
  ok(audit.some((e) => e.detail?.connector === "notion" && e.detail?.reason === "leaked token"), "connector.revoke: audits admin.connector.revoke with the reason");
}

function bodyField(body: string, field: string): string | null {
  return new URLSearchParams(body).get(field);
}

function payloadFor(actionId: string, opts: { org?: string; user?: string; channel?: string; ts?: string } = {}) {
  return {
    actions: [{ action_id: actionId, value: opts.org ?? "default" }],
    user: { id: opts.user ?? "U_ORG_ADMIN" },
    channel: { id: opts.channel ?? "C1" },
    message: { ts: opts.ts ?? "111.222" },
  };
}

{
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: "999.999" };
  };
  const handled = await handleApprovalPayload(payloadFor("eve_input:resume:abc"), { post });
  ok(handled === false, "handleApprovalPayload: a non-oe_approval action_id returns false (caller forwards to Eve)");
  ok(calls.length === 0, "handleApprovalPayload: a non-matching payload never touches Slack");

  ok((await handleApprovalPayload({ actions: [] }, { post })) === false, "handleApprovalPayload: no actions at all also returns false");
  ok((await handleApprovalPayload(null, { post })) === false, "handleApprovalPayload: a null payload is handled without throwing");
}

{
  const store = getOperationalStore();
  const expiredRow = row({ id: "p-expired", expiresAt: "2000-01-01T00:00:00Z" });
  await store.addPendingAction(expiredRow);

  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true };
  };
  const handled = await handleApprovalPayload(payloadFor("oe_approval:approve:p-expired"), { post });
  ok(handled === true, "handleApprovalPayload: an oe_approval click always returns true (it owns the click)");
  const after = await store.getPendingAction("default", "p-expired");
  ok(after?.status === "expired" && after?.decidedBy === "system", "handleApprovalPayload: a click on an aged-out pending CAS-expires it");
  ok(calls.some((c) => c.method === "chat.update" && (bodyField(c.body, "text") ?? "").includes("Expired")), "handleApprovalPayload: the card is updated to the expired state");
  const ttlExpiry = (await readAudit({ org: "default", action: "approval.expired" })).find((e) => e.detail?.id === "p-expired");
  ok(ttlExpiry?.detail?.cause === "ttl" && ttlExpiry?.principalId === "system", "a late click past TTL audits approval.expired with cause \"ttl\"");
}

{
  const store = getOperationalStore();
  await store.addPendingAction(row({ id: "p-member", kind: "test.member", argsJson: "{}", domain: null }));
  memberExecuted = [];
  const post = async () => ({ ok: true });
  const handled = await handleApprovalPayload(payloadFor("oe_approval:approve:p-member", { user: "U_RANDOM_MEMBER" }), { post });
  ok(handled === true, "handleApprovalPayload: member-policy click handled");
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "handleApprovalPayload: a member-policy kind executes for ANY clicker, no admin check");
  ok((await store.getPendingAction("default", "p-member"))?.status === "approved", "handleApprovalPayload: member-policy approval decides the row");
}

{
  const store = getOperationalStore();
  await store.addPendingAction(row({ id: "p-admin-denied", domain: null }));
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true };
  };
  const handled = await handleApprovalPayload(payloadFor("oe_approval:approve:p-admin-denied", { user: "U_RANDOM_MEMBER" }), { post });
  ok(handled === true, "handleApprovalPayload: an admin-policy click by a non-admin still returns true");
  ok((await store.getPendingAction("default", "p-admin-denied"))?.status === "pending", "handleApprovalPayload: a denied admin click leaves the row PENDING (not consumed)");
  ok(calls.some((c) => c.method === "chat.postMessage" && (bodyField(c.body, "text") ?? "").includes("only a domain/org admin")), "handleApprovalPayload: a denial posts an explanatory note");

  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: null }, "U_ORG_ADMIN") === true, "clickerMayDecide: org admin covers a domain-less scope");
  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: null }, "U_RANDOM_MEMBER") === false, "clickerMayDecide: a plain member does not cover a domain-less scope");
  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: "eng" }, "U_ENG_ADMIN") === true, "clickerMayDecide: the FROZEN domain's own admin covers it");
  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: "eng" }, "U_RANDOM_MEMBER") === false, "clickerMayDecide: a non-admin does not cover an explicit domain either");

  const domainCapRow = (level: "domain" | "surface" | "workspace") =>
    row({
      id: "p-domain-cap",
      kind: "spend.set",
      argsJson: JSON.stringify({ org: "default", scopeKey: "eng", level, monthlyTokens: 5000, currentCap: null }),
      domain: "eng",
    });
  ok(clickerMayDecide(domainCapRow("domain"), "U_ENG_ADMIN") === false, "clickerMayDecide: eng's OWN domain admin is REFUSED for a domain-level spend cap on eng, despite row.domain === \"eng\"");
  ok(clickerMayDecide(domainCapRow("domain"), "U_RANDOM_MEMBER") === false, "clickerMayDecide: a plain member is (still) refused for a domain-level spend cap");
  ok(clickerMayDecide(domainCapRow("domain"), "U_ORG_ADMIN") === true, "clickerMayDecide: the ORG admin CAN decide a domain-level spend cap");
  ok(clickerMayDecide(domainCapRow("surface"), "U_ENG_ADMIN") === true, "clickerMayDecide: eng's domain admin STILL covers a surface-level spend cap (the refusal is level-specific, not blanket)");
  const domainClearRow = row({
    id: "p-domain-clear",
    kind: "spend.clear",
    argsJson: JSON.stringify({ org: "default", scopeKey: "eng", level: "domain", currentCap: null }),
    domain: "eng",
  });
  ok(clickerMayDecide(domainClearRow, "U_ENG_ADMIN") === false, "clickerMayDecide: eng's domain admin is REFUSED for a domain-level spend.clear too");
  ok(clickerMayDecide(domainClearRow, "U_ORG_ADMIN") === true, "clickerMayDecide: org admin can still decide a domain-level spend.clear");
  const nonSpendRow = row({
    id: "p-non-spend",
    kind: "connector.revoke",
    argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C_ENG", connector: "notion", level: "domain" }),
    domain: "eng",
  });
  ok(clickerMayDecide(nonSpendRow, "U_ENG_ADMIN") === true, "clickerMayDecide: the domain-level spend carve-out is scoped to spend.set/spend.clear only — a connector.revoke row's domain admin is unaffected even with a same-shaped argsJson");
}

{
  const store = getOperationalStore();
  await store.addPendingAction(
    row({
      id: "p-happy",
      argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T3/C3", level: "surface", monthlyTokens: 500, currentCap: null }),
      domain: null,
    }),
  );
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true };
  };
  const handled = await handleApprovalPayload(payloadFor("oe_approval:approve:p-happy", { user: "U_ORG_ADMIN" }), { post });
  ok(handled === true, "handleApprovalPayload: approve happy-path returns true");

  const decided = await store.getPendingAction("default", "p-happy");
  ok(decided?.status === "approved" && decided?.decidedBy === "U_ORG_ADMIN", "handleApprovalPayload: approve happy-path decides the row");

  const capsAfter = await effectiveCaps("default", "slack/T3", "slack/T3/C3");
  ok(capsAfter.surfaceMonthlyTokens === 500, "handleApprovalPayload: approve happy-path actually EXECUTES the frozen mutation");

  ok(calls.some((c) => c.method === "chat.update" && (bodyField(c.body, "text") ?? "").includes("Approved by")), "handleApprovalPayload: the card is updated to the approved state");

  const audit = await readAudit({ org: "default", action: "approval.approved" });
  ok(audit.some((e) => e.detail?.id === "p-happy" && e.principalId === "U_ORG_ADMIN"), "handleApprovalPayload: audits approval.approved with the clicker as principal");

  await getOperationalStore().clearSpendLimit("default", "slack/T3/C3", "surface");
}

{
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: "555.666" };
  };
  const { id, expiresAt } = await requestApproval(
    {
      org: "default",
      kind: "spend.set",
      args: { org: "default", scopeKey: "slack/T4/C4", level: "surface", monthlyTokens: 750, currentCap: null },
      scopeKey: "slack/T4/C4",
      requestedBy: "U_REQUESTER",
      channelId: "C4",
    },
    { post },
  );
  ok(typeof id === "string" && id.length > 0, "requestApproval: returns a generated id");
  ok(new Date(expiresAt).getTime() > Date.now(), "requestApproval: expiresAt is in the future (default TTL)");
  const posted = await getOperationalStore().getPendingAction("default", id);
  ok(posted?.messageTs === "555.666", "requestApproval: stores the card's message ts after posting");
  ok(calls.some((c) => c.method === "chat.postMessage" && (bodyField(c.body, "blocks") ?? "").includes("oe_approval:approve:")), "requestApproval: posts a card whose blocks carry an oe_approval: approve action_id");
  const audit = await readAudit({ org: "default", action: "approval.requested" });
  ok(audit.some((e) => e.detail?.id === id && e.principalId === "U_REQUESTER"), "requestApproval: audits approval.requested with the requester as principal");
  ok(!calls.some((c) => bodyField(c.body, "thread_ts") !== null), "requestApproval: no threadTs -> the card posts as a fresh channel message (no thread_ts param)");

  await requestApproval(
    {
      org: "default",
      kind: "spend.set",
      args: { org: "default", scopeKey: "slack/T4/C4", level: "surface", monthlyTokens: 750, currentCap: null },
      scopeKey: "slack/T4/C4",
      requestedBy: "U_REQUESTER",
      channelId: "C4",
      threadTs: "1751.0042",
    },
    { post },
  );
  ok(
    calls.some((c) => c.method === "chat.postMessage" && bodyField(c.body, "thread_ts") === "1751.0042"),
    "requestApproval: threadTs -> the card posts INTO that thread (thread_ts on chat.postMessage)",
  );

  await assert.rejects(
    async () => requestApproval({ org: "default", kind: "no.such.kind", args: {}, scopeKey: "slack/T4/C4", requestedBy: "U_REQUESTER", channelId: "C4" }, { post }),
    /no registered ActionKind/,
    "requestApproval: rejects an unregistered kind",
  );
  n++;

  const failingPost = async () => undefined;
  let threw = false;
  try {
    await requestApproval(
      { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T5/C5", level: "surface", monthlyTokens: 1, currentCap: null }, scopeKey: "slack/T5/C5", requestedBy: "U_REQUESTER", channelId: "C5" },
      { post: failingPost },
    );
  } catch (err) {
    threw = true;
    ok(/failed to post/.test(String(err)), "requestApproval: throws an explanatory error when the card never posts");
  }
  ok(threw, "requestApproval: throws when the Slack post fails (a pending nobody can see must not linger)");
  const postFailExpiry = (await readAudit({ org: "default", action: "approval.expired" })).find((e) => e.detail?.cause === "card_post_failed");
  ok(postFailExpiry?.detail?.kind === "spend.set" && postFailExpiry?.principalId === "U_REQUESTER", "requestApproval: a failed card post audits approval.expired with cause \"card_post_failed\"");
}

{
  markCardPostedThisTurn();
  ok(consumeCardPostedThisTurn() === false, "card-signal: outside an Eve context, mark/consume are no-ops (fail-soft, never false-positive)");

  const post = async () => ({ ok: true, ts: "777.888" });

  await inSession(async () => {
    ok(consumeCardPostedThisTurn() === false, "card-signal: a fresh session starts with no card posted");
    await requestApproval(
      { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T6/C6", level: "surface", monthlyTokens: 1, currentCap: null }, scopeKey: "slack/T6/C6", requestedBy: "U_REQUESTER", channelId: "C6" },
      { post },
    );
    ok(consumeCardPostedThisTurn() === true, "card-signal: requestApproval's successful post marks the flag");
    ok(consumeCardPostedThisTurn() === false, "card-signal: consuming resets it — a second read in the same session sees false again (the next turn starts clean)");
  });

  await inSession(async () => {
    ok(consumeCardPostedThisTurn() === false, "card-signal: a different session is unaffected by a previous session's card");
  });

  const failingPost = async () => undefined;
  await inSession(async () => {
    await assert.rejects(
      async () =>
        requestApproval(
          { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T7/C7", level: "surface", monthlyTokens: 1, currentCap: null }, scopeKey: "slack/T7/C7", requestedBy: "U_REQUESTER", channelId: "C7" },
          { post: failingPost },
        ),
      /failed to post/,
    );
    n++;
    ok(consumeCardPostedThisTurn() === false, "card-signal: a failed post (card never reached Slack) does NOT mark the flag — the thrown error still replies normally");
  });
}

{
  const store = getOperationalStore();
  await store.addPendingAction(row({ id: "p-sweep", org: "sweeporg", scopeKey: "slack/T9/C9", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
  const noneYet = await sweepExpiredPendings("sweeporg", new Date(Date.now() - 3_600_000));
  ok(noneYet === 0 && (await store.getPendingAction("sweeporg", "p-sweep"))?.status === "pending", "sweepExpiredPendings: a pending still inside its TTL is left pending");
  const swept = await sweepExpiredPendings("sweeporg", new Date(Date.now() + 7_200_000));
  ok(swept === 1, "sweepExpiredPendings: an aged-out pending is expired by the sweep (count 1)");
  const after = await store.getPendingAction("sweeporg", "p-sweep");
  ok(after?.status === "expired" && after?.decidedBy === "system", "sweepExpiredPendings: the swept row flips to expired (decidedBy system)");
  const swExpiry = (await readAudit({ org: "sweeporg", action: "approval.expired" })).find((e) => e.detail?.id === "p-sweep");
  ok(swExpiry?.detail?.cause === "ttl", "sweepExpiredPendings: the sweep audits approval.expired with cause \"ttl\"");
  ok((await sweepExpiredPendings("sweeporg", new Date(Date.now() + 7_200_000))) === 0, "sweepExpiredPendings: a second sweep expires nothing (row already terminal)");
}

console.log(`\n✓ approvals: ${n} assertions passed (card render, store CAS, registry, execute parity, click matrix, card-signal, TTL sweep)\n`);
