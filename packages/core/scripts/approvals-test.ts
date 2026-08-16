
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { PendingActionRow } from "../agent/approvals/types.js";
import type { UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const dir = join(tmpdir(), `open-everywhere-approvals-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig, getConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { parseApprovalAction, requestApproval, handleApprovalPayload, resolveApprovalClick, clickerMayDecide, OE_APPROVAL_PREFIX, sweepExpiredPendings } = await import("../agent/approvals/flow.js");
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
    defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG_ADMIN", "slack/TW/U_ORG_ADMIN"] }),
    defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], admins: ["slack/T1/U_ENG_ADMIN"] }),
    defineDomain({ name: "win", channels: ["slack/TW/C_WIN"], admins: ["slack/T1/U_ORG_ADMIN"], ambientSupervisor: true, mode: "solo" }),
    defineDomain({ name: "dwin", channels: ["discord/GW/C_DWIN"], admins: ["discord/U_ORG_ADMIN"], ambientSupervisor: true, mode: "solo" }),
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
    postedTo: null,
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
  ok(JSON.stringify(parseApprovalAction("oe_approval:approve_session:p-1")) === JSON.stringify({ decision: "approve_session", id: "p-1" }), "parses an approve_session action_id (OPE-53)");
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
  ok(ids.length === 2 && !ids.some((i) => i.includes("approve_session")), "a non-pr.open card has NO 'Approve for session' button (session skip is pr.open-only)");

  const prCard = pendingCardBlocks(row({ id: "p-pr", kind: "pr.open" }), ["open PR"]);
  const prActions = prCard.blocks.find((b) => b.type === "actions") as unknown as { elements: { action_id: string; text: { text: string } }[] } | undefined;
  const prIds = prActions!.elements.map((e) => e.action_id);
  ok(prIds.length === 3, "a pr.open card renders three buttons");
  ok(prIds.includes(`${OE_APPROVAL_PREFIX}approve_session:p-pr`), "a pr.open card carries the id-scoped approve_session action_id");
  ok(parseApprovalAction(prIds.find((i) => i.includes("approve_session"))!) !== null, "the pr.open approve_session action_id round-trips through parseApprovalAction");
  ok(prActions!.elements.some((e) => e.text.text === "Approve for session"), "the middle button is labelled 'Approve for session'");
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
  const { withTaintDisclosure, taintDisclosureLine, TAINT_DISCLOSURE_PREFIX } = await import("../agent/approvals/taint-disclosure.js");
  const { summarizeFrozenRow } = await import("../agent/approvals/actions.js");
  const { markUntrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");

  ok(taintDisclosureLine(false) === undefined, "disclosure: an untainted proposal renders NO line (positive-only, so a clean card is unchanged)");
  ok(taintDisclosureLine(true)!.startsWith(TAINT_DISCLOSURE_PREFIX), "disclosure: the line opens with the one exported prefix");
  ok(taintDisclosureLine(true, ["web", "github"])!.includes("from web, github"), "disclosure: the line NAMES the source kinds when the turn recorded them");
  ok(!taintDisclosureLine(true)!.includes("from "), "disclosure: …and degrades to the bare fact when it has no breakdown (a seeded taint knows the bit, not the sources)");

  const plain = withTaintDisclosure(["Open a PR against acme/web"], { tainted: true }, { live: false });
  ok(plain.length === 2 && plain[1]!.startsWith(TAINT_DISCLOSURE_PREFIX), "disclosure: a kind with no ⚠ prose of its own gains the generic line");
  const clean = withTaintDisclosure(["Open a PR against acme/web"], { tainted: false }, { live: false });
  ok(clean.length === 1, "disclosure: negative control — a clean proposal's lines are untouched");

  const bespoke = ["Set a cap", "⚠ proposed in a turn that read external content — confirm a person actually asked"];
  ok(withTaintDisclosure(bespoke, { tainted: true }, { live: false }).length === 2, "disclosure: a kind that already discloses is NOT given a second, redundant line");
  const enriched = withTaintDisclosure(bespoke, { tainted: true }, { live: false, kinds: ["notion"] });
  ok(enriched.length === 3 && enriched[2]!.includes("notion"), "disclosure: …but the SOURCE breakdown is still added, because its own line cannot carry it");

  await inSession(async () => {
    markUntrustedIngestedThisTurn("web");
    const live = withTaintDisclosure(["Forget one bullet"], { siloName: "eng" });
    ok(live.length === 2 && live[1]!.includes("from web"), "disclosure: a kind that freezes NO tainted flag still discloses at propose time, naming the live source");
    const frozenOnly = withTaintDisclosure(["Forget one bullet"], { siloName: "eng" }, { live: false });
    ok(frozenOnly.length === 1, "disclosure: …and a RE-RENDER (live:false) shows nothing — a clicker's own turn must never leak onto someone else's card");

    const rendered = summarizeFrozenRow(row({ kind: "test.member", argsJson: JSON.stringify({ tainted: true }) }));
    ok(rendered.some((l) => l.startsWith(TAINT_DISCLOSURE_PREFIX)), "disclosure: summarizeFrozenRow (the click/control-plane renderer) carries the line from the FROZEN flag");
    const renderedClean = summarizeFrozenRow(row({ kind: "test.member", argsJson: JSON.stringify({}) }));
    ok(!renderedClean.some((l) => l.startsWith(TAINT_DISCLOSURE_PREFIX)), "disclosure: …and a clean frozen row renders none, in the same tainted turn (frozen beats live on a re-render)");
  });
}

{
  delete process.env.GITHUB_TOKEN;
  const store = getOperationalStore();
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();

  await store.setSessionApproval({ org: "default", sessionId: "sess-A", kind: "pr.open", grantedBy: "U_ORG_ADMIN", createdAt: now, expiresAt: future });
  ok((await store.getSessionApproval("default", "sess-A", "pr.open", now))?.grantedBy === "U_ORG_ADMIN", "setSessionApproval → getSessionApproval returns the live memo");
  ok((await store.getSessionApproval("default", "sess-B", "pr.open", now)) === null, "a different session misses the memo (session-scoped)");
  ok((await store.getSessionApproval("default", "sess-A", "create_skill", now)) === null, "a different kind misses the memo (kind-scoped)");
  await store.setSessionApproval({ org: "default", sessionId: "sess-exp", kind: "pr.open", grantedBy: "U_ORG_ADMIN", createdAt: "2000-01-01T00:00:00Z", expiresAt: "2000-01-01T01:00:00Z" });
  ok((await store.getSessionApproval("default", "sess-exp", "pr.open", now)) === null, "an expired memo reads as null");

  const post = async () => ({ ok: true, ts: "1.1" });
  const sid = "oe-dom:eng:oe-sup:g7";
  await store.addPendingAction(row({
    id: "p-prsess",
    kind: "pr.open",
    domain: null,
    argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C1", repo: "acme/web", head: "fix/x", base: "main", title: "t", body: "b", headSha: "a".repeat(40), requestedBy: "U_REQUESTER", sessionId: sid }),
  }));
  ok((await handleApprovalPayload(payloadFor("oe_approval:approve_session:p-prsess"), { post })) === true, "approve_session click is owned by the handler");
  ok((await store.getSessionApproval("default", sid, "pr.open", new Date().toISOString()))?.grantedBy === "U_ORG_ADMIN", "approve_session on a pr.open card sets the session memo, attributed to the clicker");
  ok((await readAudit({ org: "default", action: "approval.session_granted" })).some((e) => e.detail?.id === "p-prsess"), "the session grant is audited (approval.session_granted)");

  const beforeExec = memberExecuted.length;
  await store.addPendingAction(row({ id: "p-membersess", kind: "test.member", domain: null, argsJson: JSON.stringify({ sessionId: "sess-member" }) }));
  await handleApprovalPayload(payloadFor("oe_approval:approve_session:p-membersess", { user: "U_ORG_ADMIN" }), { post });
  ok((await store.getSessionApproval("default", "sess-member", "test.member", new Date().toISOString())) === null, "approve_session on a non-pr.open kind sets NO memo (kind-scoped enforcement)");
  ok((await store.getSessionApproval("default", "sess-member", "pr.open", new Date().toISOString())) === null, "…and none under pr.open either");
  ok(memberExecuted.length > beforeExec, "the non-pr.open kind still EXECUTED as an ordinary one-off approve");
}

{
  const store = getOperationalStore();
  ok((await store.getPendingAction("default", "p-store")) === null, "store: unknown id returns null");

  const r = row({ id: "p-store" });
  await store.addPendingAction(r);
  const fetched = await store.getPendingAction("default", "p-store");
  ok(fetched !== null && fetched.status === "pending" && fetched.domain === null, "store: round-trips a freshly-inserted row");
  ok(fetched?.argsJson === r.argsJson, "store: argsJson round-trips byte-for-byte (frozen args)");
  ok(fetched?.postedTo === null, "store: a NULL postedTo (pre-migration/map row) reads back null");

  await store.addPendingAction(row({ id: "p-store-posted", postedTo: "slack/T1/C1" }));
  ok((await store.getPendingAction("default", "p-store-posted"))?.postedTo === "slack/T1/C1", "store: postedTo round-trips byte-for-byte (frozen mint identity)");

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

function payloadFor(actionId: string, opts: { org?: string; user?: string; channel?: string; ts?: string; team?: string } = {}) {
  return {
    actions: [{ action_id: actionId, value: opts.org ?? "default" }],
    user: { id: opts.user ?? "U_ORG_ADMIN" },
    team: { id: opts.team ?? "T1" },
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
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "handleApprovalPayload: a member-policy kind runs NO admin-standing check on the clicker (this payload carries no team.id ⇒ no clickContext ⇒ the OPE-185 gate is inert)");
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
  const adminDenied = (await readAudit({ org: "default", action: "approval.denied" })).find((e) => e.detail?.id === "p-admin-denied");
  ok(adminDenied?.detail?.reason === "not-admin" && adminDenied?.principalId === "U_RANDOM_MEMBER", "a refused ADMIN-tier click audits approval.denied (reason \"not-admin\") — it audited nothing at all before OPE-185");
  ok(
    adminDenied?.detail?.venuePlatform === "slack" && adminDenied?.detail?.venueWorkspace === "T1" && adminDenied?.detail?.venueChannel === "C1",
    "OPE-332: approval.denied names the venue the refused click happened in (non-redirected)",
  );

  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: null }, "U_ORG_ADMIN", "slack", "T1") === true, "clickerMayDecide: org admin covers a domain-less scope");
  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: null }, "U_RANDOM_MEMBER", "slack", "T1") === false, "clickerMayDecide: a plain member does not cover a domain-less scope");
  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: "eng" }, "U_ENG_ADMIN", "slack", "T1") === true, "clickerMayDecide: the FROZEN domain's own admin covers it");
  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: "eng" }, "U_RANDOM_MEMBER", "slack", "T1") === false, "clickerMayDecide: a non-admin does not cover an explicit domain either");

  const domainCapRow = (level: "domain" | "surface" | "workspace") =>
    row({
      id: "p-domain-cap",
      kind: "spend.set",
      argsJson: JSON.stringify({ org: "default", scopeKey: "eng", level, monthlyTokens: 5000, currentCap: null }),
      domain: "eng",
    });
  ok(clickerMayDecide(domainCapRow("domain"), "U_ENG_ADMIN", "slack", "T1") === false, "clickerMayDecide: eng's OWN domain admin is REFUSED for a domain-level spend cap on eng, despite row.domain === \"eng\"");
  ok(clickerMayDecide(domainCapRow("domain"), "U_RANDOM_MEMBER", "slack", "T1") === false, "clickerMayDecide: a plain member is (still) refused for a domain-level spend cap");
  ok(clickerMayDecide(domainCapRow("domain"), "U_ORG_ADMIN", "slack", "T1") === true, "clickerMayDecide: the ORG admin CAN decide a domain-level spend cap");
  ok(clickerMayDecide(domainCapRow("surface"), "U_ENG_ADMIN", "slack", "T1") === true, "clickerMayDecide: eng's domain admin STILL covers a surface-level spend cap (the refusal is level-specific, not blanket)");
  const domainClearRow = row({
    id: "p-domain-clear",
    kind: "spend.clear",
    argsJson: JSON.stringify({ org: "default", scopeKey: "eng", level: "domain", currentCap: null }),
    domain: "eng",
  });
  ok(clickerMayDecide(domainClearRow, "U_ENG_ADMIN", "slack", "T1") === false, "clickerMayDecide: eng's domain admin is REFUSED for a domain-level spend.clear too");
  ok(clickerMayDecide(domainClearRow, "U_ORG_ADMIN", "slack", "T1") === true, "clickerMayDecide: org admin can still decide a domain-level spend.clear");
  const nonSpendRow = row({
    id: "p-non-spend",
    kind: "connector.revoke",
    argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C_ENG", connector: "notion", level: "domain" }),
    domain: "eng",
  });
  ok(clickerMayDecide(nonSpendRow, "U_ENG_ADMIN", "slack", "T1") === true, "clickerMayDecide: the domain-level spend carve-out is scoped to spend.set/spend.clear only — a connector.revoke row's domain admin is unaffected even with a same-shaped argsJson");

  const userCapRow = (kind: "spend.set" | "spend.clear", frozenDomain: string | null) =>
    row({
      id: `p-user-cap-${kind}`,
      kind,
      argsJson: JSON.stringify({ org: "default", scopeKey: "user:slack/T1/U_ENG_MEMBER", level: "user", monthlyTokens: 5000, currentCap: null }),
      domain: frozenDomain,
    });
  ok(clickerMayDecide(userCapRow("spend.set", "eng"), "U_ENG_ADMIN", "slack", "T1") === false, "🔴 OPE-274: a domain admin is REFUSED for a per-user spend cap even with a frozen domain that would otherwise grant them standing");
  ok(clickerMayDecide(userCapRow("spend.set", null), "U_ENG_ADMIN", "slack", "T1") === false, "OPE-274: …and refused on the shape the tools actually freeze (domain: null) — the second, structural fence");
  ok(clickerMayDecide(userCapRow("spend.set", "eng"), "U_RANDOM_MEMBER", "slack", "T1") === false, "OPE-274: a plain member is refused for a per-user spend cap");
  ok(clickerMayDecide(userCapRow("spend.set", "eng"), "U_ORG_ADMIN", "slack", "T1") === true, "OPE-274: the ORG admin CAN decide a per-user spend cap");
  ok(clickerMayDecide(userCapRow("spend.clear", "eng"), "U_ENG_ADMIN", "slack", "T1") === false, "OPE-274: clearing a per-user allowance override carries the same bar as setting one");
  ok(clickerMayDecide(userCapRow("spend.clear", "eng"), "U_ORG_ADMIN", "slack", "T1") === true, "OPE-274: …and the org admin can still decide it");
  ok(clickerMayDecide(domainCapRow("surface"), "U_ENG_ADMIN", "slack", "T1") === true && clickerMayDecide(domainCapRow("workspace"), "U_ENG_ADMIN", "slack", "T1") === true, "OPE-274: adding the user level did NOT widen the carve-out — surface/workspace caps keep the domain-admin fallback");

  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: null }, "U_ORG_ADMIN", "discord", undefined) === false, "🔴 clickerMayDecide: the org admin's SLACK id does NOT decide from a discord click — a bare-id roster would have matched across the two namespaces");
  ok(clickerMayDecide({ ...row({ id: "p-admin-denied" }), domain: null }, "U_ORG_ADMIN", undefined, undefined) === false, "clickerMayDecide: FAIL-CLOSED with no clicker platform — the roster arm refuses rather than matching a bare id");
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
  const happy = audit.find((e) => e.detail?.id === "p-happy");
  ok(
    happy?.detail?.venuePlatform === "slack" && happy?.detail?.venueWorkspace === "T1" && happy?.detail?.venueChannel === "C1",
    "OPE-332: approval.approved names the venue it was decided in (non-redirected — the asking room)",
  );

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
      postedTo: "slack/T4/C4",
      chain: { unattended: false },
    },
    { post },
  );
  ok(typeof id === "string" && id.length > 0, "requestApproval: returns a generated id");
  ok(new Date(expiresAt).getTime() > Date.now(), "requestApproval: expiresAt is in the future (default TTL)");
  const posted = await getOperationalStore().getPendingAction("default", id);
  ok(posted?.messageTs === "555.666", "requestApproval: stores the card's message ts after posting");
  ok(posted?.postedTo === "slack/T4/C4", "requestApproval: freezes the proposing surfaceKey onto the row at mint");
  ok(calls.some((c) => c.method === "chat.postMessage" && (bodyField(c.body, "blocks") ?? "").includes("oe_approval:approve:")), "requestApproval: posts a card whose blocks carry an oe_approval: approve action_id");
  const audit = await readAudit({ org: "default", action: "approval.requested" });
  ok(audit.some((e) => e.detail?.id === id && e.principalId === "U_REQUESTER"), "requestApproval: audits approval.requested with the requester as principal");
  ok(!calls.some((c) => bodyField(c.body, "thread_ts") !== null), "requestApproval: no threadTs -> the card posts as a fresh channel message (no thread_ts param)");

  await requestApproval(
    {
      org: "default",
      kind: "spend.set",
      args: { org: "default", scopeKey: "slack/T4/C4", level: "surface", monthlyTokens: 751, currentCap: null },
      scopeKey: "slack/T4/C4",
      requestedBy: "U_REQUESTER",
      channelId: "C4",
      threadTs: "1751.0042",
      chain: { unattended: false },
    },
    { post },
  );
  ok(
    calls.some((c) => c.method === "chat.postMessage" && bodyField(c.body, "thread_ts") === "1751.0042"),
    "requestApproval: threadTs -> the card posts INTO that thread (thread_ts on chat.postMessage)",
  );

  await assert.rejects(
    async () => requestApproval({ org: "default", kind: "no.such.kind", args: {}, scopeKey: "slack/T4/C4", requestedBy: "U_REQUESTER", channelId: "C4", chain: { unattended: false } }, { post }),
    /no registered ActionKind/,
    "requestApproval: rejects an unregistered kind",
  );
  n++;

  const failingPost = async () => undefined;
  let threw = false;
  try {
    await requestApproval(
      { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T5/C5", level: "surface", monthlyTokens: 1, currentCap: null }, scopeKey: "slack/T5/C5", requestedBy: "U_REQUESTER", channelId: "C5", chain: { unattended: false } },
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
  const spoofArgs = {
    org: "default",
    kind: "spend.set",
    args: { org: "default", scopeKey: "slack/T7/C7", level: "surface", monthlyTokens: 4242, currentCap: null },
    scopeKey: "slack/T7/C7",
    requestedBy: "U_REQUESTER",
    channelId: "C7",
    chain: { unattended: false },
  } as const;

  let posterCalls = 0;
  const postCard = async () => {
    posterCalls++;
    return "vendor-message-id";
  };

  process.env.OE_EGRESS_SPOOF = "1";
  const spoofed = await requestApproval(spoofArgs, { postCard });
  delete process.env.OE_EGRESS_SPOOF;
  ok(posterCalls === 0, "egress spoof: the registered CardPoster is NEVER called — the vendor REST post is swallowed");
  const spoofedRow = await getOperationalStore().getPendingAction("default", spoofed.id);
  ok(spoofedRow?.messageTs?.startsWith("spoof-card-") === true, "egress spoof: the pending row carries the synthetic card ts, so it stays real and clickable-in-principle");
  ok(spoofedRow?.status === "pending", "egress spoof: the pending is NOT expired — the swallowed post counts as posted");
  ok(
    (await readAudit({ org: "default", action: "approval.requested" })).some((e) => e.detail?.id === spoofed.id),
    "egress spoof: approval.requested still lands, exactly as it would with a live token",
  );

  const live = await requestApproval({ ...spoofArgs, args: { ...spoofArgs.args, monthlyTokens: 4243 } }, { postCard });
  ok(posterCalls === 1, "egress spoof control: with the flag OFF the registered CardPoster IS called");
  ok((await getOperationalStore().getPendingAction("default", live.id))?.messageTs === "vendor-message-id", "egress spoof control: the vendor poster's own message id is stored");
}

{
  const store = getOperationalStore();
  const calls: { method: string; body: string }[] = [];
  let ts = 700;
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: `${ts++}.0` };
  };
  const args = { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T9/C9", level: "surface", monthlyTokens: 1234, currentCap: null }, scopeKey: "slack/T9/C9", requestedBy: "U_REQUESTER", channelId: "C9", chain: { unattended: false } } as const;

  const first = await requestApproval(args, { post });
  ok(first.deduped !== true, "requestApproval dedup: the FIRST proposal is a real mint (not deduped)");
  const postsAfterFirst = calls.filter((c) => c.method === "chat.postMessage").length;

  const second = await requestApproval(args, { post });
  ok(second.deduped === true, "requestApproval dedup: an IDENTICAL pending proposal on the same surface is deduped");
  ok(second.id === first.id, "requestApproval dedup: the deduped result points at the SAME live pending id");
  ok(calls.filter((c) => c.method === "chat.postMessage").length === postsAfterFirst, "requestApproval dedup: no SECOND card is posted for the duplicate");
  ok((await store.listPendingActions("default")).filter((r) => r.scopeKey === "slack/T9/C9").length === 1, "requestApproval dedup: exactly ONE pending row exists for the duplicated action");

  const different = await requestApproval({ ...args, args: { ...args.args, monthlyTokens: 5678 } }, { post });
  ok(different.deduped !== true && different.id !== first.id, "requestApproval dedup: a different proposed value is NOT deduped — it mints a fresh card");
}

{
  const calls: { method: string; body: string }[] = [];
  let ts = 750;
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: `${ts++}.0` };
  };
  const proposal = { org: "default", scopeKey: "slack/T11/C11", level: "surface", monthlyTokens: 4321, currentCap: null };
  await getOperationalStore().addPendingAction(
    row({ id: "p-wall-expired", scopeKey: "slack/T11/C11", channelId: "C11", argsJson: JSON.stringify(proposal), expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  );
  const fresh = await requestApproval(
    { org: "default", kind: "spend.set", args: proposal, scopeKey: "slack/T11/C11", requestedBy: "U_REQUESTER", channelId: "C11", chain: { unattended: false } },
    { post },
  );
  ok(fresh.deduped !== true, "dedup: a wall-expired row the sweep hasn't reaped yet is NOT deduped against");
  ok(fresh.id !== "p-wall-expired", "dedup: the proposal past a wall-expired twin mints a genuinely NEW pending id");
}

{
  const store = getOperationalStore();
  const calls: { method: string; body: string }[] = [];
  let ts = 800;
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: `${ts++}.0` };
  };
  const args = { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T10/C10", level: "surface", monthlyTokens: 42, currentCap: null }, scopeKey: "slack/T10/C10", requestedBy: "U_REQUESTER", channelId: "C10", threadTs: "ANCHOR.10", chain: { unattended: false } } as const;

  const first = await requestApproval(args, { post });
  await handleApprovalPayload(payloadFor(`oe_approval:reject:${first.id}`, { user: "U_ORG_ADMIN", channel: "C10", ts: "800.0" }), { post });
  ok((await store.getPendingAction("default", first.id))?.status === "rejected", "re-propose: the reject decides the row to rejected");

  const again = await requestApproval(args, { post });
  ok(again.deduped !== true, "re-propose: an identical proposal after a REJECTION is NOT deduped");
  ok(again.id !== first.id, "re-propose: the re-proposal is a genuinely NEW pending id, not the rejected one");

  const notice = calls.find((c) => c.method === "chat.postMessage" && bodyField(c.body, "thread_ts") === "ANCHOR.10" && (bodyField(c.body, "text") ?? "").includes("REJECTED"));
  ok(!!notice, "decision notice: a REJECT posts a fresh message into the pending's anchor thread (thread_ts = the mint-time anchor)");
  ok((bodyField(notice!.body, "text") ?? "").includes("NOT applied"), "decision notice: the reject notice states plainly the change was NOT applied (never an auto-retry)");
}

{
  const store = getOperationalStore();
  await store.addPendingAction(
    row({
      id: "p-notice-approve",
      argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T11/C11", level: "surface", monthlyTokens: 900, currentCap: null }),
      scopeKey: "slack/T11/C11",
      channelId: "C11",
      threadTs: "ANCHOR.11",
      domain: null,
    }),
  );
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true };
  };
  await handleApprovalPayload(payloadFor("oe_approval:approve:p-notice-approve", { user: "U_ORG_ADMIN", channel: "C11", ts: "111.222" }), { post });
  const approveNotice = calls.find((c) => c.method === "chat.postMessage" && bodyField(c.body, "thread_ts") === "ANCHOR.11" && (bodyField(c.body, "text") ?? "").includes("APPROVED"));
  ok(!!approveNotice, "decision notice: an APPROVE posts a fresh 'APPROVED' message into the anchor thread");
  await getOperationalStore().clearSpendLimit("default", "slack/T11/C11", "surface");
}

{
  markCardPostedThisTurn();
  ok(consumeCardPostedThisTurn() === false, "card-signal: outside an Eve context, mark/consume are no-ops (fail-soft, never false-positive)");

  const post = async () => ({ ok: true, ts: "777.888" });

  await inSession(async () => {
    ok(consumeCardPostedThisTurn() === false, "card-signal: a fresh session starts with no card posted");
    await requestApproval(
      { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T6/C6", level: "surface", monthlyTokens: 1, currentCap: null }, scopeKey: "slack/T6/C6", requestedBy: "U_REQUESTER", channelId: "C6", chain: { unattended: false } },
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
          { org: "default", kind: "spend.set", args: { org: "default", scopeKey: "slack/T7/C7", level: "surface", monthlyTokens: 1, currentCap: null }, scopeKey: "slack/T7/C7", requestedBy: "U_REQUESTER", channelId: "C7", chain: { unattended: false } },
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

{
  const store = getOperationalStore();
  const { dispatchApprovalDecisionWake } = await import("../agent/channels/unified.js");
  const { supervisorGrainFor } = await import("../agent/channels/unified-supervisor.js");
  type WakeInput = Parameters<typeof dispatchApprovalDecisionWake>[0];
  const slackOrigin = (o: UnifiedWakeOrigin): Extract<UnifiedWakeOrigin, { platform: "slack" }> | null => (o.platform === "slack" ? o : null);

  overrideSettingsForTest({ window: { topology: true } });
  try {
    const grain = supervisorGrainFor("slack/TW/C_WIN", getConfig().loadDomains());
    ok(grain.unified === true && grain.domainName === "win", "window setup: the win domain's channel resolves a unified grain keyed by the domain");

    const WIN_TOKEN = "oe-dom:win:win:slack/TW/C_WIN:oe-sup:g1";
    await store.rotateChannelSession("default", grain.registryKey, WIN_TOKEN, new Date().toISOString());

    const wakes: WakeInput[] = [];
    const decisionWake = {
      dispatch: async (i: WakeInput): Promise<boolean> => {
        wakes.push(i);
        return true;
      },
      mintWakeId: () => "wake-fixed",
      now: () => "2026-07-19T00:00:00Z",
    };
    const post = async () => ({ ok: true });
    const winPayload = (actionId: string, opts: { user?: string; org?: string; channel?: string; team?: string } = {}) => ({
      actions: [{ action_id: actionId, value: opts.org ?? "default" }],
      user: { id: opts.user ?? "U_ORG_ADMIN" },
      channel: { id: opts.channel ?? "C_WIN" },
      message: { ts: "111.222" },
      team: { id: opts.team ?? "TW" },
    });
    const winRow = (over: Partial<PendingActionRow>) =>
      row({
        scopeKey: "slack/TW/C_WIN",
        channelId: "C_WIN",
        threadTs: "ANCHOR.W",
        domain: null,
        argsJson: JSON.stringify({ org: over.org ?? "default", scopeKey: "slack/TW/C_WIN", level: "surface", monthlyTokens: 700, currentCap: null }),
        ...over,
      });

    await store.addPendingAction(winRow({ id: "p-win-reject" }));
    wakes.length = 0;
    await handleApprovalPayload(winPayload("oe_approval:reject:p-win-reject"), { post, decisionWake });
    ok(wakes.length === 1, "decision wake: a REJECT in a window domain emits EXACTLY ONE decision wake");
    ok(wakes[0]!.token === WIN_TOKEN, "decision wake: the wake targets the proposing window's CURRENT registry token");
    ok(wakes[0]!.domain === "win", "decision wake: the wake carries the proposing window's domain");
    const oRej = slackOrigin(wakes[0]!.origin);
    ok(!!oRej && oRej.channelId === "C_WIN" && oRej.threadTs === "ANCHOR.W", "decision wake: origin = the card's own anchor thread (a warranted reply lands beside the notice)");
    ok(wakes[0]!.message.includes("REJECTED") && wakes[0]!.message.includes("NOT applied"), "decision wake: the rejected notice states the outcome + that nothing was applied");
    ok(wakes[0]!.message.includes("p-win-reject"), "decision wake: the notice names the pending id so the model can correlate it");
    ok(wakes[0]!.wakeId === "wake-fixed", "decision wake: the host-minted wakeId rides the dispatch (reply-target map key)");

    await store.addPendingAction(winRow({ id: "p-win-approve", argsJson: JSON.stringify({ org: "default", scopeKey: "slack/TW/C_WIN", level: "surface", monthlyTokens: 800, currentCap: null }) }));
    wakes.length = 0;
    await handleApprovalPayload(winPayload("oe_approval:approve:p-win-approve"), { post, decisionWake });
    ok(wakes.length === 1 && wakes[0]!.message.includes("APPROVED"), "decision wake: an APPROVE in a window domain emits one wake carrying the approved outcome");
    await store.clearSpendLimit("default", "slack/TW/C_WIN", "surface");

    await store.addPendingAction(winRow({ id: "p-win-expire", expiresAt: "2000-01-01T00:00:00Z", argsJson: JSON.stringify({ org: "default", scopeKey: "slack/TW/C_WIN", level: "surface", monthlyTokens: 900, currentCap: null }) }));
    wakes.length = 0;
    await handleApprovalPayload(winPayload("oe_approval:approve:p-win-expire"), { post, decisionWake });
    ok(wakes.length === 1 && wakes[0]!.message.includes("EXPIRED"), "decision wake: a late click that EXPIRES a window-domain pending emits one wake carrying the expired outcome");

    await store.addPendingAction(row({ id: "p-eng-reject", scopeKey: "slack/T1/C_ENG", channelId: "C_ENG", threadTs: "ANCHOR.E", domain: null, argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C_ENG", level: "surface", monthlyTokens: 100, currentCap: null }) }));
    wakes.length = 0;
    await handleApprovalPayload(winPayload("oe_approval:reject:p-eng-reject", { channel: "C_ENG", team: "T1" }), { post, decisionWake });
    ok(wakes.length === 0, "decision wake: a decide on a NON-window (classic per-thread) domain emits NO decision wake");

    await store.addPendingAction(winRow({ id: "p-win-nosess", org: "nosess" }));
    wakes.length = 0;
    await handleApprovalPayload(winPayload("oe_approval:reject:p-win-nosess", { org: "nosess" }), { post, decisionWake });
    ok(wakes.length === 0, "decision wake: a window domain with no live session row emits no wake (nothing to push to)");

    await store.addPendingAction(winRow({ id: "p-win-noteam" }));
    wakes.length = 0;
    await handleApprovalPayload(
      { actions: [{ action_id: "oe_approval:reject:p-win-noteam", value: "default" }], user: { id: "U_ORG_ADMIN" }, channel: { id: "C_WIN" }, message: { ts: "111.222" } },
      { post, decisionWake },
    );
    ok(wakes.length === 0, "decision wake: a payload missing team.id emits no wake (the surfaceKey can't be formed — fail-soft)");
  } finally {
    overrideSettingsForTest({ window: { topology: false } });
  }
}

{
  const store = getOperationalStore();
  const { dispatchApprovalDecisionWake } = await import("../agent/channels/unified.js");
  const { supervisorGrainFor } = await import("../agent/channels/unified-supervisor.js");
  type WakeInput = Parameters<typeof dispatchApprovalDecisionWake>[0];

  overrideSettingsForTest({ window: { topology: true } });
  try {
    const past = new Date(Date.now() - 60_000).toISOString();
    const spendArgs = (scopeKey: string, tokens: number) => JSON.stringify({ org: "sweepfb", scopeKey, level: "surface", monthlyTokens: tokens, currentCap: null });

    const winGrain = supervisorGrainFor("slack/TW/C_WIN", getConfig().loadDomains());
    const dwinGrain = supervisorGrainFor("discord/GW/C_DWIN", getConfig().loadDomains());
    ok(dwinGrain.unified === true && dwinGrain.domainName === "dwin", "sweep-feedback setup: the discord window domain resolves a unified grain");
    const WIN_TOKEN = "oe-dom:win:win:slack/TW/C_WIN:oe-sup:g1";
    const DWIN_TOKEN = "oe-dom:dwin:win:discord/GW/C_DWIN:oe-sup:g1";
    await store.rotateChannelSession("sweepfb", winGrain.registryKey, WIN_TOKEN, new Date().toISOString());
    await store.rotateChannelSession("sweepfb", dwinGrain.registryKey, DWIN_TOKEN, new Date().toISOString());

    await store.addPendingAction(
      row({ id: "fb-slack", org: "sweepfb", scopeKey: "slack/TW/C_WIN", channelId: "C_WIN", threadTs: "ANCHOR.S", messageTs: "111.9", postedTo: "slack/TW/C_WIN", argsJson: spendArgs("slack/TW/C_WIN", 111), expiresAt: past }),
    );
    await store.addPendingAction(
      row({ id: "fb-discord", org: "sweepfb", scopeKey: "discord/GW/C_DWIN", channelId: "C_DWIN", threadTs: null, messageTs: "dmsg-9", postedTo: "discord/GW/C_DWIN", argsJson: spendArgs("discord/GW/C_DWIN", 222), expiresAt: past }),
    );
    await store.addPendingAction(row({ id: "fb-null", org: "sweepfb", scopeKey: "slack/TW/C_WIN", channelId: "C_WIN", postedTo: null, argsJson: spendArgs("slack/TW/C_WIN", 333), expiresAt: past }));

    const slackCalls: { method: string; body: string }[] = [];
    const post = async (method: string, body: string) => {
      slackCalls.push({ method, body });
      return { ok: true };
    };
    const discordNotices: { rowId: string; text: string }[] = [];
    const discordNotice = async (r: PendingActionRow, text: string) => {
      discordNotices.push({ rowId: r.id, text });
      return "dmsg-notice";
    };
    const wakes: WakeInput[] = [];
    const decisionWake = {
      dispatch: async (i: WakeInput): Promise<boolean> => {
        wakes.push(i);
        return true;
      },
      mintWakeId: () => "wake-sweep",
      now: () => "2026-07-20T00:00:00Z",
    };

    const swept = await sweepExpiredPendings("sweepfb", new Date(), { post, discordNotice, decisionWake });
    ok(swept === 3, "sweep feedback: all three aged-out rows are expired (feedback never gates the expiry itself)");
    ok((await store.getPendingAction("sweepfb", "fb-null"))?.status === "expired", "sweep feedback: the NULL-postedTo row still expires normally");

    const slackNotice = slackCalls.find((c) => c.method === "chat.postMessage" && bodyField(c.body, "thread_ts") === "ANCHOR.S");
    ok(!!slackNotice, "sweep feedback: the Slack row's expiry notice posts into the mint-frozen anchor thread");
    ok((bodyField(slackNotice!.body, "text") ?? "").includes("EXPIRED") && (bodyField(slackNotice!.body, "text") ?? "").includes("NOT applied"), "sweep feedback: the Slack notice states EXPIRED + nothing applied");
    ok(bodyField(slackNotice!.body, "channel") === "C_WIN", "sweep feedback: the Slack notice targets the row's own channel");

    ok(discordNotices.length === 1 && discordNotices[0]!.rowId === "fb-discord", "sweep feedback: the Discord row's expiry notice goes through the Discord poster exactly once");
    ok(discordNotices[0]!.text.includes("EXPIRED") && discordNotices[0]!.text.includes("NOT applied"), "sweep feedback: the Discord notice is the same code-rendered decision text");

    ok(wakes.length === 2, "sweep feedback: exactly the two FROZEN rows emit a decision wake (NULL postedTo emits none)");
    const slackWake = wakes.find((w) => w.token === WIN_TOKEN);
    ok(!!slackWake && slackWake.domain === "win", "sweep feedback: the Slack wake targets the win seat's current registry token");
    ok(slackWake!.origin.platform === "slack" && (slackWake!.origin as { channelId: string }).channelId === "C_WIN" && (slackWake!.origin as { threadTs?: string }).threadTs === "ANCHOR.S", "sweep feedback: the Slack wake origin is the card's own anchor thread");
    ok(slackWake!.message.includes("EXPIRED without a decision") && slackWake!.message.includes("fb-slack"), "sweep feedback: the Slack wake carries the expired outcome (no deciding admin) + the pending id");
    const discordWake = wakes.find((w) => w.token === DWIN_TOKEN);
    ok(!!discordWake && discordWake.domain === "dwin", "sweep feedback: the Discord wake targets the dwin seat's current registry token");
    const dOrigin = discordWake!.origin as { platform: string; channelId: string; guildId: string; messageId?: string };
    ok(dOrigin.platform === "discord" && dOrigin.guildId === "GW" && dOrigin.channelId === "C_DWIN" && dOrigin.messageId === "dmsg-9", "sweep feedback: the Discord wake origin carries the frozen guild + channel, anchored to the card message");

    await store.rotateChannelSession("sweepthrow", winGrain.registryKey, WIN_TOKEN, new Date().toISOString());
    await store.addPendingAction(
      row({ id: "fb-throws", org: "sweepthrow", scopeKey: "slack/TW/C_WIN", channelId: "C_WIN", threadTs: "ANCHOR.T", postedTo: "slack/TW/C_WIN", argsJson: JSON.stringify({ org: "sweepthrow", scopeKey: "slack/TW/C_WIN", level: "surface", monthlyTokens: 1, currentCap: null }), expiresAt: past }),
    );
    let dispatchAttempts = 0;
    const throwingDeps = {
      post: async () => {
        throw new Error("slack down");
      },
      decisionWake: {
        dispatch: async (): Promise<boolean> => {
          dispatchAttempts++;
          throw new Error("dispatch down");
        },
      },
    };
    const sweptThrow = await sweepExpiredPendings("sweepthrow", new Date(), throwingDeps);
    ok(sweptThrow === 1, "sweep feedback: a throwing notice AND a throwing wake never abort the sweep (the row still expires + counts)");
    ok(dispatchAttempts === 1, "sweep feedback: the wake is still attempted after the notice threw (the two legs are independent)");
    ok((await store.getPendingAction("sweepthrow", "fb-throws"))?.status === "expired", "sweep feedback: the row is terminal despite both feedback legs failing");
  } finally {
    overrideSettingsForTest({ window: { topology: false } });
  }
}

{
  const { registerGovernanceMemberSupplier, _resetAudienceFloorCacheForTest, _resetGovernanceMemberSupplierForTest } = await import("../agent/access/audience-floor.js");
  const { classifyClickerFloor, clickRoomMatches, clickerFloorRefusalNotice } = await import("../agent/approvals/clicker-floor.js");
  const store = getOperationalStore();

  const benefitExecuted: string[] = [];
  registerActionKind({
    kind: "test.beneficiary",
    policy: "member",
    beneficiaryClicker: true,
    summarize: () => ["a beneficiary member-policy test action"],
    async execute(_args: unknown, decidedBy: string) {
      benefitExecuted.push(decidedBy);
      return `executed by ${decidedBy}`;
    },
  });
  const adminExecuted: string[] = [];
  registerActionKind({
    kind: "test.admin",
    policy: "admin",
    summarize: () => ["an admin-policy test action"],
    async execute(_args: unknown, decidedBy: string) {
      adminExecuted.push(decidedBy);
      return `executed by ${decidedBy}`;
    },
  });

  const roster = (over: Partial<{ resolved: boolean; hasGuest: boolean; isPrivate: boolean }> = {}) => ({
    humanMemberIds: ["U1"],
    resolved: true,
    isPrivate: true,
    hasGuest: false,
    ...over,
  });
  ok(
    classifyClickerFloor({ floor: "guest", roster: roster({ hasGuest: true }), beneficiaryClicker: false }).ok === false,
    "classifyClickerFloor: an OBSERVED guest floor refuses",
  );
  ok(
    classifyClickerFloor({ floor: "guest", roster: roster({ resolved: false }), beneficiaryClicker: false }).ok === true,
    "classifyClickerFloor: an UNOBSERVABLE roster (floor \"guest\" by fail-closed default) is INERT, not a refusal — the anti-outage pin",
  );
  ok(classifyClickerFloor({ floor: "member", roster: roster(), beneficiaryClicker: false }).ok === true, "classifyClickerFloor: a resolved non-guest room allows");
  const unattested = classifyClickerFloor({ floor: "guest", roster: roster({ resolved: false }), beneficiaryClicker: true });
  ok(unattested.ok === false && unattested.reason === "unattested-room", "classifyClickerFloor: leg B — a BENEFICIARY kind refuses on an unattested roster the witness arm allows");
  ok(classifyClickerFloor({ floor: "member", roster: roster(), beneficiaryClicker: true }).ok === true, "classifyClickerFloor: leg B — a beneficiary kind allows once the roster is positively resolved");
  const guestBeneficiary = classifyClickerFloor({ floor: "guest", roster: roster({ hasGuest: true }), beneficiaryClicker: true });
  ok(guestBeneficiary.ok === false && guestBeneficiary.reason === "audience-floor", "classifyClickerFloor: an observed guest is reported as the stronger tier-wide reason even on a beneficiary kind");

  ok(clickRoomMatches(row({ channelId: "C_A" }), "slack/T1/C_A") === true, "clickRoomMatches: a click in the card's own room matches");
  ok(clickRoomMatches(row({ channelId: "C_A" }), "slack/T1/C_B") === false, "clickRoomMatches: a click from another room does not");
  ok(clickRoomMatches(row({ channelId: "C_A" }), "slack/T99/C_A") === true, "clickRoomMatches: only the CHANNEL segment is compared — a venue-routed card's config-authored workspace segment must never cause a refusal");
  ok(clickRoomMatches(row({ channelId: "C_A" }), "not-a-surface-key") === true, "clickRoomMatches: a key with no channel segment is INERT, never a refusal");

  const notices = (["audience-floor", "unattested-room", "foreign-room", "guest-clicker"] as const).map((r) => clickerFloorRefusalNotice(r));
  ok(new Set(notices).size === 4, "clickerFloorRefusalNotice: each refusal reason gets its own copy");
  ok(notices.every((t) => t.toLowerCase().includes("still pending")), "clickerFloorRefusalNotice: every refusal says the request is STILL PENDING (the card is not consumed)");

  const { checkClickerFloor } = await import("../agent/approvals/clicker-floor.js");
  let floorDepCalls = 0;
  const guestClickerVerdict = await checkClickerFloor(
    "slack/T1/C_INTERNAL",
    { beneficiaryClicker: false, clickerIsGuest: true },
    { floor: async () => { floorDepCalls++; return { floor: "member", roster: roster() }; } },
  );
  ok(guestClickerVerdict.ok === false && guestClickerVerdict.reason === "guest-clicker", "checkClickerFloor: a POSITIVE per-clicker guest verdict refuses guest-clicker, even in an otherwise-clean room");
  ok(floorDepCalls === 0, "checkClickerFloor: leg D short-circuits — the room roster is never consulted once the clicker is refused");

  const memberClickerVerdict = await checkClickerFloor(
    "slack/T1/C_INTERNAL",
    { beneficiaryClicker: false, clickerIsGuest: false },
    { floor: async () => { floorDepCalls++; return { floor: "member", roster: roster() }; } },
  );
  ok(memberClickerVerdict.ok === true, "checkClickerFloor: a POSITIVE per-clicker MEMBER verdict (false) falls through to the room floor and allows");
  ok(floorDepCalls === 1, "checkClickerFloor: an explicit non-guest verdict still consults the room floor (leg D did not swallow leg A)");

  const noVerdict = await checkClickerFloor(
    "slack/T1/C_INTERNAL",
    { beneficiaryClicker: false },
    { floor: async () => { floorDepCalls++; return { floor: "member", roster: roster() }; } },
  );
  ok(noVerdict.ok === true, "checkClickerFloor: an ABSENT per-clicker verdict (the Slack-probe-unavailable case) is inert — falls through to the room floor");
  ok(floorDepCalls === 2, "checkClickerFloor: the absent-verdict case also consults the room floor");

  _resetAudienceFloorCacheForTest();
  const ROSTERS: Record<string, ReturnType<typeof roster>> = {
    "slack/T1/C_GUEST": roster({ hasGuest: true }),
    "slack/T1/C_INTERNAL": roster(),
  };
  let supplierCalls = 0;
  registerGovernanceMemberSupplier(async (key: string) => {
    supplierCalls++;
    return ROSTERS[key];
  });

  const post = async () => ({ ok: true });
  const clickPayload = (actionId: string, opts: { user?: string; channel: string; team?: string | null }) => ({
    actions: [{ action_id: actionId, value: "default" }],
    user: { id: opts.user ?? "U_RANDOM_MEMBER" },
    channel: { id: opts.channel },
    message: { ts: "111.222" },
    ...(opts.team === null ? {} : { team: { id: opts.team ?? "T1" } }),
  });
  const deniedAudit = async (id: string) => (await readAudit({ org: "default", action: "approval.denied" })).find((e) => e.detail?.id === id);

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-cf-guest", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_GUEST", postedTo: null }));
  const guestCalls: { method: string; body: string }[] = [];
  const handledGuest = await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-guest", { channel: "C_GUEST" }), {
    post: async (method: string, body: string) => {
      guestCalls.push({ method, body });
      return { ok: true };
    },
  });
  ok(handledGuest === true, "clicker gate: a refused click still returns true (the handler owns it; Slack always gets its 200)");
  ok(memberExecuted.length === 0, "clicker gate: an OBSERVED-guest room does NOT execute the member-tier kind");
  ok((await store.getPendingAction("default", "p-cf-guest"))?.status === "pending", "clicker gate: a refused click leaves the row PENDING — the same card can still be decided from an internal room");
  ok((await deniedAudit("p-cf-guest"))?.detail?.reason === "audience-floor", "clicker gate: the refusal writes ONE approval.denied audit row naming the reason");
  ok(guestCalls.some((c) => c.method === "chat.postMessage" && (bodyField(c.body, "text") ?? "").includes("still pending")), "clicker gate: the clicker gets the one-renderer refusal note in-thread");
  ok(guestCalls.every((c) => c.method !== "chat.update"), "clicker gate: the card itself is left untouched (nothing was decided)");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-cf-unknown", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_UNKNOWN", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-unknown", { channel: "C_UNKNOWN" }), { post });
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "clicker gate: an UNRESOLVED roster EXECUTES — \"we could not ask\" must never become a silent product outage");
  ok((await store.getPendingAction("default", "p-cf-unknown"))?.status === "approved", "clicker gate: the unresolved-roster click decides the row normally");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-cf-internal", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_INTERNAL", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-internal", { channel: "C_INTERNAL" }), { post });
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "clicker gate: a resolved, guest-free room executes");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-cf-nocontext", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_GUEST", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-nocontext", { channel: "C_GUEST", team: null }), { post });
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "clicker gate: NO clickContext executes even with a GUEST roster registered — the headless control plane must keep working");

  ok((await store.getPendingAction("default", "p-cf-guest"))?.postedTo === null, "clicker gate: the refused row had postedTo === null and the gate handled it without throwing (legacy rows stay clickable)");

  adminExecuted.length = 0;
  await store.addPendingAction(row({ id: "p-cf-admin", kind: "test.admin", argsJson: "{}", domain: null, channelId: "C_GUEST", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-admin", { channel: "C_GUEST", user: "U_ORG_ADMIN" }), { post });
  ok(
    adminExecuted.includes("U_ORG_ADMIN"),
    "clicker gate: an ADMIN-tier kind EXECUTES under an observed-guest roster — the clicker legs are member-tier only, admin standing is already checked, and the GUEST-AUDIENCE exposure is answered at PROPOSE time by OPE-220, never by refusing a click on a card that is already in the room",
  );

  benefitExecuted.length = 0;
  await store.addPendingAction(row({ id: "p-cf-benefit-unknown", kind: "test.beneficiary", argsJson: "{}", domain: null, channelId: "C_UNKNOWN", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-benefit-unknown", { channel: "C_UNKNOWN" }), { post });
  ok(benefitExecuted.length === 0, "clicker gate leg B: a BENEFICIARY kind REFUSES on the very roster the witness arm executes on (p-cf-unknown, same channel)");
  ok((await store.getPendingAction("default", "p-cf-benefit-unknown"))?.status === "pending", "clicker gate leg B: the beneficiary refusal leaves the row pending");
  ok((await deniedAudit("p-cf-benefit-unknown"))?.detail?.reason === "unattested-room", "clicker gate leg B: the refusal audits reason \"unattested-room\"");

  await store.addPendingAction(row({ id: "p-cf-benefit-ok", kind: "test.beneficiary", argsJson: "{}", domain: null, channelId: "C_INTERNAL", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-benefit-ok", { channel: "C_INTERNAL" }), { post });
  ok(benefitExecuted.includes("U_RANDOM_MEMBER"), "clicker gate leg B: a beneficiary kind executes in an ATTESTED room");

  ok(actionKind("webhook.rotate")?.beneficiaryClicker === true, "clicker gate leg B: webhook.rotate carries beneficiaryClicker (its execute reveals a live signing secret to the DECIDER)");
  ok(actionKind("webhook.create") === undefined && actionKind("webhook.revoke") === undefined, "clicker gate leg B: webhook.create/webhook.revoke are GONE (OPE-224) — a hook is created and removed by merged PRs");
  ok(actionKind("webhook.declare")?.beneficiaryClicker === undefined && actionKind("pr.open")?.beneficiaryClicker === undefined, "clicker gate leg B: witness kinds (webhook.declare, pr.open) do NOT carry it — opening a PR hands the clicker nothing");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-cf-foreign", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_INTERNAL", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-foreign", { channel: "C_ELSEWHERE" }), { post });
  ok(memberExecuted.length === 0 && (await store.getPendingAction("default", "p-cf-foreign"))?.status === "pending", "clicker gate leg C: a click from a room that isn't the card's does not decide the row");
  ok((await deniedAudit("p-cf-foreign"))?.detail?.reason === "foreign-room", "clicker gate leg C: the refusal audits reason \"foreign-room\"");

  adminExecuted.length = 0;
  await store.addPendingAction(row({ id: "p-cf-foreign-admin", kind: "test.admin", argsJson: "{}", domain: null, channelId: "C_INTERNAL", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-foreign-admin", { channel: "C_ELSEWHERE", user: "U_ORG_ADMIN" }), { post });
  ok(adminExecuted.length === 0, "clicker gate leg C: the room binding is TIER-INDEPENDENT — it is a claim about the click's provenance, not about standing");

  ok(supplierCalls > 0, "clicker gate: the member supplier was actually consulted (the wired legs are not silently short-circuiting)");

  memberExecuted = [];
  const supplierCallsBeforeLegD = supplierCalls;
  await store.addPendingAction(row({ id: "p-cf-guest-clicker", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_INTERNAL", postedTo: null }));
  const handledGuestClicker = await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-guest-clicker", { channel: "C_INTERNAL" }), {
    post,
    clickerIsGuest: async () => true,
  });
  ok(handledGuestClicker === true, "clicker gate leg D: a refused click still returns true");
  ok(memberExecuted.length === 0, "clicker gate leg D: a POSITIVE per-clicker guest verdict refuses even a resolved, guest-free ROOM");
  ok((await store.getPendingAction("default", "p-cf-guest-clicker"))?.status === "pending", "clicker gate leg D: the row stays pending");
  ok((await deniedAudit("p-cf-guest-clicker"))?.detail?.reason === "guest-clicker", "clicker gate leg D: the refusal audits reason \"guest-clicker\"");
  ok(supplierCalls === supplierCallsBeforeLegD, "clicker gate leg D: the room member supplier was never consulted — leg D short-circuits before the room roster");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-cf-member-clicker", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_INTERNAL", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-member-clicker", { channel: "C_INTERNAL" }), {
    post,
    clickerIsGuest: async () => false,
  });
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "clicker gate leg D control: a POSITIVE per-clicker MEMBER verdict (false) executes normally");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-cf-clicker-probe-throws", kind: "test.member", argsJson: "{}", domain: null, channelId: "C_INTERNAL", postedTo: null }));
  await handleApprovalPayload(clickPayload("oe_approval:approve:p-cf-clicker-probe-throws", { channel: "C_INTERNAL" }), {
    post,
    clickerIsGuest: async () => { throw new Error("boom"); },
  });
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "clicker gate leg D: a THROWN clickerIsGuest dep degrades to no verdict, never aborts the click");

  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
}

{
  const { registerGovernanceMemberSupplier, _resetAudienceFloorCacheForTest, _resetGovernanceMemberSupplierForTest } = await import("../agent/access/audience-floor.js");
  const { classifyCardDisclosure, cardDisclosureRefusalNotice } = await import("../agent/approvals/card-disclosure.js");
  const store = getOperationalStore();

  const roster = (over: Partial<{ resolved: boolean; hasGuest: boolean; isPrivate: boolean }> = {}) => ({
    humanMemberIds: ["U1"],
    resolved: true,
    isPrivate: true,
    hasGuest: false,
    ...over,
  });

  ok(classifyCardDisclosure({ floor: "guest", roster: roster({ hasGuest: true }) }).ok === false, "classifyCardDisclosure: an OBSERVED guest floor refuses the card");
  ok(classifyCardDisclosure({ floor: "guest", roster: roster({ resolved: false }) }).ok === true, "classifyCardDisclosure: an UNOBSERVABLE roster (floor \"guest\" by fail-closed default) is INERT, not a refusal — the anti-outage pin");
  ok(classifyCardDisclosure({ floor: "member", roster: roster() }).ok === true, "classifyCardDisclosure: a resolved, guest-free room allows");
  ok(classifyCardDisclosure({ floor: "admin", roster: roster() }).ok === true, "classifyCardDisclosure: an all-admin private room allows");

  const notice = cardDisclosureRefusalNotice();
  ok(notice.length > 0 && !/spend|token|\$|domain|scope|forget|memory\b/i.test(notice), "cardDisclosureRefusalNotice: CONTENT-FREE — it names no action kind, figure, domain or scope");
  ok(/extern|guest/i.test(notice) && /channel/i.test(notice), "cardDisclosureRefusalNotice: names the room property and the concrete fix, not merely the blockage");

  _resetAudienceFloorCacheForTest();
  const CARD_ROSTERS: Record<string, ReturnType<typeof roster>> = {
    "slack/T7/C_SHARED": roster({ hasGuest: true }),
    "slack/T7/C_PRIVATE": roster(),
  };
  registerGovernanceMemberSupplier(async (key: string) => CARD_ROSTERS[key]);

  const posts: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    posts.push({ method, body });
    return { ok: true, ts: "777.888" };
  };
  const propose = (over: Record<string, unknown>) =>
    requestApproval(
      {
        org: "default",
        kind: "spend.set",
        args: { org: "default", scopeKey: "slack/T7/C_SHARED", level: "surface", monthlyTokens: 9001, currentCap: null },
        scopeKey: "slack/T7/C_SHARED",
        requestedBy: "U_ADMIN",
        channelId: "C_SHARED",
        ...over,
        chain: { unattended: false },
      } as Parameters<typeof requestApproval>[0],
      { post },
    );
  const proposeThrew = async (over: Record<string, unknown>): Promise<boolean> => {
    try {
      await propose(over);
      return false;
    } catch {
      return true;
    }
  };
  const proposeDenials = async () =>
    (await readAudit({ org: "default", action: "approval.denied" })).filter((e) => e.detail?.at === "propose");

  const beforeRows = (await store.listPendingActions("default")).length;
  posts.length = 0;
  ok(await proposeThrew({ postedTo: "slack/T7/C_SHARED" }), "card disclosure: proposing into an OBSERVED-guest room throws rather than posting a card");
  ok(posts.length === 0, "card disclosure: the refused proposal posts NOTHING — the disclosure is prevented, not merely audited after the fact");
  ok((await store.listPendingActions("default")).length === beforeRows, "card disclosure: the refusal mints NO pending row (the gate runs before addPendingAction, so there is nothing to expire)");
  const denial = (await proposeDenials()).find((e) => e.detail?.postedTo === "slack/T7/C_SHARED");
  ok(denial?.detail?.reason === "audience-floor", "card disclosure: the refusal audits approval.denied naming the audience-floor reason");
  ok(denial?.detail?.id === undefined && denial?.principalId === "U_ADMIN", "card disclosure: the propose-time row carries NO pending id (none was created) and names the REQUESTER as principal");

  posts.length = 0;
  const okProposal = await propose({
    channelId: "C_PRIVATE",
    scopeKey: "slack/T7/C_PRIVATE",
    args: { org: "default", scopeKey: "slack/T7/C_PRIVATE", level: "surface", monthlyTokens: 9002, currentCap: null },
    postedTo: "slack/T7/C_PRIVATE",
  });
  ok(typeof okProposal.id === "string" && okProposal.id.length > 0, "card disclosure: an internal room proposes normally");
  ok(posts.some((c) => c.method === "chat.postMessage"), "card disclosure: the allowed proposal actually posts its card");

  posts.length = 0;
  const opaque = await propose({
    channelId: "C_OPAQUE",
    scopeKey: "slack/T7/C_OPAQUE",
    args: { org: "default", scopeKey: "slack/T7/C_OPAQUE", level: "surface", monthlyTokens: 9003, currentCap: null },
    postedTo: "slack/T7/C_OPAQUE",
  });
  ok(typeof opaque.id === "string", "card disclosure: an UNRESOLVED roster proposes normally — every non-Slack surface stays byte-identical to the pre-OPE-220 path");

  posts.length = 0;
  const legacy = await propose({
    args: { org: "default", scopeKey: "slack/T7/C_SHARED", level: "surface", monthlyTokens: 9004, currentCap: null },
  });
  ok(typeof legacy.id === "string", "card disclosure: a proposal with NO postedTo is INERT even with a GUEST roster registered — \"we could not ask\" never refuses");

  registerActionKind({
    kind: "test.member.disclosive",
    policy: "member",
    summarize: () => ["a member-tier card carrying content"],
    async execute() {
      return "ok";
    },
  });
  posts.length = 0;
  const memberRefused = await proposeThrew({
    kind: "test.member.disclosive",
    args: { marker: "member-tier-into-shared-room" },
    postedTo: "slack/T7/C_SHARED",
  });
  ok(memberRefused, "card disclosure: a MEMBER-tier card refuses in the SAME room an admin-tier card refuses in — the gate is tier-blind, so a per-tier fix could not have left this open");
  ok(posts.length === 0, "card disclosure: the member-tier refusal posts nothing either");
  ok(actionKind("spend.set")?.policy === "admin" && actionKind("test.member.disclosive")?.policy === "member", "card disclosure: the two refusals above genuinely straddle the tier boundary (the differential is real, not two admin kinds)");

  posts.length = 0;
  const dedupArgs = {
    channelId: "C_LATERSHARED",
    scopeKey: "slack/T7/C_LATERSHARED",
    args: { org: "default", scopeKey: "slack/T7/C_LATERSHARED", level: "surface", monthlyTokens: 9005, currentCap: null },
    postedTo: "slack/T7/C_LATERSHARED",
  };
  CARD_ROSTERS["slack/T7/C_LATERSHARED"] = roster();
  const armed = await propose(dedupArgs);
  ok(typeof armed.id === "string", "card disclosure ordering: the first proposal lands while the room is still internal");
  CARD_ROSTERS["slack/T7/C_LATERSHARED"] = roster({ hasGuest: true });
  _resetAudienceFloorCacheForTest();
  ok(await proposeThrew(dedupArgs), "card disclosure ordering: an IDENTICAL re-proposal after the room goes externally shared REFUSES — it is not handed back the live card by the dedup path");

  {
    const src = readFileSync(join(REPO, "packages/core/agent/approvals/card-disclosure.ts"), "utf8");
    ok(/from "\.\.\/access\/audience-floor\.js"/.test(src), "single-source: consumer #5 (approvals/card-disclosure.ts) imports the audience-floor seam");
    ok(/export function computeAudienceFloor\b/.test(src) === false, "single-source: consumer #5 does NOT re-roll the floor computation");
    ok(/clicker-floor/.test(src) === false || /from "\.\/clicker-floor\.js"/.test(src) === false, "separation: the card gate does not import the clicker gate — \"who clicked\" and \"who was in the room\" stay distinct planes");
  }

  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
}

{
  const store = getOperationalStore();
  const entryFor = async (action: string, id: string) => (await readAudit({ org: "default", action })).find((e) => e.detail?.id === id);

  const redirected = (over: Partial<PendingActionRow>) =>
    row({ kind: "test.member", argsJson: "{}", domain: null, scopeKey: "linear/WS9/ISSUE-42", channelId: "C_ENG", postedTo: "slack/T1/C_ENG", ...over });

  memberExecuted = [];
  await store.addPendingAction(redirected({ id: "p-332-redirect" }));
  const approved332 = await resolveApprovalClick({ org: "default", id: "p-332-redirect", decision: "approve", clickerId: "U_RANDOM_MEMBER" });
  ok(approved332.outcome === "decided", "OPE-332 fixture: the redirected member-tier card approves normally");
  const rApproved = await entryFor("approval.approved", "p-332-redirect");
  ok(
    rApproved?.detail?.venuePlatform === "slack" && rApproved?.detail?.venueWorkspace === "T1" && rApproved?.detail?.venueChannel === "C_ENG",
    "🔴 OPE-332: a REDIRECTED approval.approved names the room the card was actually posted into, which the scopeKey cannot say",
  );
  ok(
    rApproved?.platform === "linear" && rApproved?.workspace === "WS9",
    "🔴 OPE-332: the audit row still PARTITIONS on the frozen asking scope — the venue was added as detail, nothing was re-partitioned",
  );

  await store.addPendingAction(redirected({ id: "p-332-reject" }));
  const rejected332 = await resolveApprovalClick({
    org: "default",
    id: "p-332-reject",
    decision: "reject",
    clickerId: "U_RANDOM_MEMBER",
    clickerPlatform: "slack",
    clickerTenant: "T1",
    clickContext: { surfaceKey: "slack/T1/C_ENG" },
  });
  ok(rejected332.outcome === "decided", "OPE-332 fixture: the redirected card rejects normally");
  const rRejected = await entryFor("approval.rejected", "p-332-reject");
  ok(
    rRejected?.detail?.venuePlatform === "slack" && rRejected?.detail?.venueWorkspace === "T1" && rRejected?.detail?.venueChannel === "C_ENG",
    "🔴 OPE-332: a REDIRECTED approval.rejected names the deciding room too — approve and deny stamp the same shape",
  );

  await store.addPendingAction(redirected({ id: "p-332-denied", kind: "spend.set", argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C_ENG", level: "surface", monthlyTokens: 10, currentCap: null }) }));
  const denied332 = await resolveApprovalClick({
    org: "default",
    id: "p-332-denied",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    clickerPlatform: "slack",
    clickerTenant: "T1",
    clickContext: { surfaceKey: "slack/T1/C_ENG" },
  });
  ok(denied332.outcome === "denied", "OPE-332 fixture: a non-admin click on the redirected admin-tier card is refused");
  const rDenied = await entryFor("approval.denied", "p-332-denied");
  ok(
    rDenied?.detail?.reason === "not-admin" && rDenied?.detail?.venuePlatform === "slack" && rDenied?.detail?.venueWorkspace === "T1" && rDenied?.detail?.venueChannel === "C_ENG",
    "🔴 OPE-332: a REDIRECTED approval.denied names the room the refused click happened in, alongside the reason",
  );
  ok((await store.getPendingAction("default", "p-332-denied"))?.status === "pending", "OPE-332 fixture: the refused click still leaves the row pending (unchanged by this ticket)");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-332-domain", kind: "test.member", argsJson: "{}", domain: "eng", scopeKey: "eng", channelId: "C_ENG", postedTo: null }));
  await resolveApprovalClick({ org: "default", id: "p-332-domain", decision: "approve", clickerId: "U_RANDOM_MEMBER" });
  const rDomain = await entryFor("approval.approved", "p-332-domain");
  ok(rDomain?.platform === "domain" && rDomain?.workspace === "eng", "OPE-332 fixture: the domain-scoped row partitions as {platform: domain, workspace: eng} (whereFromScope, unchanged)");
  ok(
    rDomain?.detail?.venuePlatform === undefined && rDomain?.detail?.venueWorkspace === undefined,
    "🔴 OPE-332: a scope that names no ROOM leaves venuePlatform/venueWorkspace ABSENT — a venue field never carries a pseudo-workspace an audit reader would absorb as a real one",
  );
  ok(rDomain?.detail?.venueChannel === "C_ENG", "OPE-332: …but the channel still lands, because channelId IS the channel the card was posted into whatever the scopeKey says");
}

{
  const { admitInputResponse, inputResponseRefusalNotice, INPUT_RESPONSE_DENIED_AUDIT_ACTION } = await import(
    "../agent/approvals/input-response-floor.js"
  );
  type Row = { action: string; principalId?: string; detail?: Record<string, unknown>; org: string };
  const rows: Row[] = [];
  const audit = async (e: unknown): Promise<void> => {
    rows.push(e as Row);
  };
  let floorCalls = 0;
  const allowFloor = async (): Promise<{ ok: true; floor: "member" }> => {
    floorCalls++;
    return { ok: true, floor: "member" };
  };
  const guestFloor = async (): Promise<{ ok: false; reason: "audience-floor"; floor: "guest" }> => {
    floorCalls++;
    return { ok: false, reason: "audience-floor", floor: "guest" };
  };
  const scope = {
    org: "default",
    platform: "slack",
    workspace: "T1",
    surface: "C1",
    surfaceKey: "slack/T1/C1",
    principalId: "U_ANSWERER",
    responses: 2,
  };
  type FloorDep = Parameters<typeof admitInputResponse>[1] extends { floor?: infer F } | undefined ? F : never;

  const allowed = await admitInputResponse(scope, { floor: allowFloor as FloorDep, audit });
  ok(allowed.ok === true, "admitInputResponse: an allowing room floor ADMITS the answer");
  ok(rows.length === 0, "admitInputResponse: an admitted answer writes no audit row");

  const refusedRoom = await admitInputResponse(scope, { floor: guestFloor as FloorDep, audit });
  ok(refusedRoom.ok === false, "🔴 admitInputResponse: an OBSERVED guest room REFUSES the answer");
  ok(refusedRoom.ok === false && refusedRoom.reason === "audience-floor", "admitInputResponse: the room refusal reports the floor's own reason");
  ok(rows.length === 1 && rows[0]!.action === INPUT_RESPONSE_DENIED_AUDIT_ACTION, "🔴 OPE-574: a refused answer is VISIBLE — exactly one input_response.denied row");
  ok(rows[0]!.principalId === "U_ANSWERER" && rows[0]!.org === "default", "OPE-574: the refusal row names the answerer and the org");
  ok(
    JSON.stringify(Object.keys(rows[0]!.detail ?? {}).sort()) === JSON.stringify(["floor", "reason", "responses"]),
    "🔴 OPE-574: the refusal detail carries the reason, the floor and a COUNT — and NOTHING else, so no answer text can reach the log",
  );
  ok(rows[0]!.detail?.responses === 2, "OPE-574: the row records how many responses the submission carried, never what they said");
  rows.length = 0;
  await admitInputResponse({ ...scope, responses: undefined }, { floor: guestFloor as FloorDep, audit });
  ok(
    JSON.stringify(Object.keys(rows[0]!.detail ?? {}).sort()) === JSON.stringify(["floor", "reason"]),
    "🔴 OPE-574: an UNKNOWN response count leaves the field ABSENT — the row never reports a zero it did not measure",
  );

  rows.length = 0;
  floorCalls = 0;
  const refusedGuest = await admitInputResponse({ ...scope, answererIsGuest: true }, { floor: allowFloor as FloorDep, audit });
  ok(refusedGuest.ok === false && refusedGuest.reason === "guest-answerer", "🔴 admitInputResponse: leg B — an observed GUEST answerer is refused even in a room the floor allows");
  ok(floorCalls === 0, "admitInputResponse: leg B short-circuits — the room floor is not consulted once the person is refused");
  ok(rows.length === 1 && rows[0]!.detail?.reason === "guest-answerer", "OPE-574: the guest-answerer refusal writes its own audited reason");

  rows.length = 0;
  ok((await admitInputResponse({ ...scope, answererIsGuest: false }, { floor: allowFloor as FloorDep, audit })).ok === true, "admitInputResponse: an observed MEMBER answerer passes leg B");
  ok((await admitInputResponse(scope, { floor: allowFloor as FloorDep, audit })).ok === true, "🔴 admitInputResponse: an ABSENT per-member verdict is INERT — the Slack case must never refuse for lack of a probe");
  ok(rows.length === 0, "admitInputResponse: neither inert case writes a row");

  const notices = (["audience-floor", "guest-answerer", "unattested-room", "foreign-room"] as const).map((r) => inputResponseRefusalNotice(r));
  ok(new Set(notices).size === 4, "inputResponseRefusalNotice: each refusal reason gets its own copy");
  ok(notices.every((t) => t.toLowerCase().includes("still open")), "🔴 inputResponseRefusalNotice: every refusal says the question is STILL OPEN — a rejected answer leaves the request pending");

  const thrownAudit = async (): Promise<void> => {
    throw new Error("store outage");
  };
  const stillRefused = await admitInputResponse(scope, { floor: guestFloor as FloorDep, audit: thrownAudit });
  ok(stillRefused.ok === false, "admitInputResponse: a failed audit write does not turn a refusal into an allow");
}

console.log(`\n✓ approvals: ${n} assertions passed (card render, OPE-307 taint disclosure, store CAS, registry, execute parity, click matrix, card-signal, TTL sweep, cross-thread decision wake, sweep expiry feedback, OPE-185 clicker gate, OPE-220 card audience gate, OPE-332 decision venue, OPE-574 HITL-answer admission)\n`);
