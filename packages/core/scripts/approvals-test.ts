import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { PendingActionRow } from "../agent/approvals/types.js";
import type { UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import { overrideSettingsForTest, getSettings } from "../agent/settings/settings.js";
import { registerSlackFixtureCodec } from "./_slack-test-stubs.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const dir = join(tmpdir(), `open-everywhere-approvals-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig, getConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { SESSION_GRANT_RELEASED_ACTION } = await import("../agent/approvals/flow.js");
const { parseApprovalAction, requestApproval, handleApprovalPayload, resolveApprovalClick, clickerMayDecide, OE_APPROVAL_PREFIX, sweepExpiredPendings, MAX_SESSION_GRANT_RELEASES } = await import("../agent/approvals/flow.js");
const { pendingCardBlocks, decidedCardBlocks, judgeLiftNoticeBlocks, judgeLiftNoticeText } = await import("../agent/approvals/card.js");
const { ROUTINE_PERMISSION_NO_EXPIRY } = await import("../agent/routines/declared-permissions.js");
const { registerActionKind, actionKind } = await import("../agent/approvals/actions.js");
const { effectiveCaps } = await import("../agent/spend/caps.js");
const { applyConnectorOverrides } = await import("../agent/access/connector-scope.js");
const { markCardPostedThisTurn, consumeCardPostedThisTurn } = await import("../agent/approvals/card-signal.js");

registerSlackFixtureCodec();

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
    defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"], admins: ["slack/T1/U_ENG_ADMIN"] }),
    defineDomain({ name: "win", reach: ["slack/TW/C_WIN"], admins: ["slack/T1/U_ORG_ADMIN"], ambientSupervisor: true, mode: "solo" }),
    defineDomain({ name: "dwin", reach: ["discord/GW/C_DWIN"], admins: ["discord/U_ORG_ADMIN"], ambientSupervisor: true, mode: "solo" }),
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

const threadKey = (thread: string): string => `oe-grant:slack/T1/C1:thread:${thread}`;
const routineKey = (routine: string): string => `oe-routine:${routine}:g1`;

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
  ok(JSON.stringify(parseApprovalAction("oe_approval:contradict:p-1")) === JSON.stringify({ decision: "contradict", id: "p-1" }), "parses a contradict action_id (OPE-965)");
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
  ok(ids.length === 2 && !ids.some((i) => i.includes("approve_session")), "a non-pr.open card has NO 'Approve for this routine' button (session skip is pr.open-only)");

  const prCard = pendingCardBlocks(row({ id: "p-pr", kind: "pr.open", argsJson: JSON.stringify({ sessionId: routineKey("r-card") }) }), ["open PR"]);
  const prActions = prCard.blocks.find((b) => b.type === "actions") as unknown as { elements: { action_id: string; text: { text: string } }[] } | undefined;
  const prIds = prActions!.elements.map((e) => e.action_id);
  ok(prIds.length === 3, "a routine's pr.open card renders three buttons");
  ok(prIds.includes(`${OE_APPROVAL_PREFIX}approve_session:p-pr`), "a routine's pr.open card carries the id-scoped approve_session action_id");
  ok(parseApprovalAction(prIds.find((i) => i.includes("approve_session"))!) !== null, "the pr.open approve_session action_id round-trips through parseApprovalAction");
  ok(prActions!.elements.some((e) => e.text.text === "Approve for this routine (up to 24 h)"), "the middle button is labelled 'Approve for this routine (up to 24 h)'");
  for (const [what, sessionId] of [
    ["a thread", threadKey("1700159720.000100")],
    ["a DM", "oe-grant:slack/T1/D1:dm"],
    ["a work-session token", "oe-dom:eng:win:w/eng:oe-sup:g7"],
  ] as const) {
    const card = pendingCardBlocks(row({ id: `p-pr-${what}`, kind: "pr.open", argsJson: JSON.stringify({ sessionId }) }), ["open PR"]);
    const ids2 = (card.blocks.find((b) => b.type === "actions") as unknown as { elements: { action_id: string }[] }).elements.map((e) => e.action_id);
    ok(ids2.length === 2 && !ids2.some((i) => i.includes("approve_session")), `🔴 OPE-2363: a pr.open card frozen in ${what} has NO middle button`);
  }
  ok(text.includes("<@U_REQUESTER>") || blocks.some((b) => JSON.stringify(b).includes("<@U_REQUESTER>")), "the requester is @-mentioned somewhere on the card");
  ok(JSON.stringify(blocks).includes(`expires ${r.expiresAt}`), "the card shows the expiry timestamp");
  const noClock = pendingCardBlocks(row({ id: "p-rp", kind: "routine.permission", expiresAt: ROUTINE_PERMISSION_NO_EXPIRY }), ["permission"]);
  ok(!JSON.stringify(noClock.blocks).includes("9999"), "🔴 OPE-2162: a no-clock card's footer never prints the 9999 sentinel");
  ok(
    JSON.stringify(noClock.blocks).includes("Requested by <@U_REQUESTER> · no expiry — ends when the routine's instruction is edited or the routine is deleted"),
    "🔴 OPE-2162: …it names the routine generation as the card's bound instead",
  );

  const decided = decidedCardBlocks({ ...r, status: "approved", decidedBy: "U_ORG_ADMIN" }, ["line one"], "spend limit set");
  ok(!decided.blocks.some((b) => b.type === "actions"), "decidedCardBlocks has NO actions block (buttons are gone once decided)");
  ok(JSON.stringify(decided.blocks).includes("✅ Approved by <@U_ORG_ADMIN>"), "decidedCardBlocks renders the approved context line");
  const rejected = decidedCardBlocks({ ...r, status: "rejected", decidedBy: "U_ORG_ADMIN" }, ["line one"], "n/a");
  ok(JSON.stringify(rejected.blocks).includes("❌ Rejected by <@U_ORG_ADMIN>"), "decidedCardBlocks renders the rejected context line");
  const expired = decidedCardBlocks({ ...r, status: "expired", decidedBy: "system" }, ["line one"], "n/a");
  ok(JSON.stringify(expired.blocks).includes("⏰ Expired"), "decidedCardBlocks renders the expired context line");

  const notice = judgeLiftNoticeBlocks({ ...r, status: "approved", decidedBy: "chain:judge" }, ["line one"], "spend limit set");
  const noticeActions = notice.blocks.find((b) => b.type === "actions") as unknown as { elements: { action_id: string; value: string; text: { text: string } }[] } | undefined;
  ok(noticeActions !== undefined, "judgeLiftNoticeBlocks includes an actions block");
  const noticeIds = noticeActions!.elements.map((e) => e.action_id);
  ok(noticeIds.length === 1 && noticeIds[0] === `${OE_APPROVAL_PREFIX}contradict:p-1`, "the notice carries EXACTLY one button — the id-scoped contradict action_id");
  ok(parseApprovalAction(noticeIds[0]!) !== null, "the notice's action_id round-trips through parseApprovalAction");
  ok(noticeActions!.elements[0]!.value === "default", "the notice button carries the org as its value (the click payload's only org source)");
  ok(noticeActions!.elements[0]!.text.text === "This should not have run", "the notice button says what it does");
  ok(!noticeIds.some((i) => i.includes("approve") || i.includes("reject")), "🔴 the notice is a REVIEW surface, never a decision one — no approve/reject on an act that already ran");
  ok(JSON.stringify(notice.blocks).includes("already run"), "the notice says the action has already run — it never implies a click could undo it");
  ok(JSON.stringify(notice.blocks).includes("spend limit set"), "the notice relays the executor's own outcome line");

  const noticeText = judgeLiftNoticeText({ ...r, status: "approved", decidedBy: "chain:judge" }, ["line one"], "spend limit set");
  ok(noticeText.includes("Ran without asking: spend.set"), "judgeLiftNoticeText names the kind, as the Block Kit header does");
  ok(noticeText.includes("line one"), "judgeLiftNoticeText carries the code-rendered summary");
  ok(noticeText.includes("spend limit set"), "judgeLiftNoticeText relays the executor's own outcome line");
  ok(noticeText.includes("already run"), "judgeLiftNoticeText says the action has already run");
  ok(noticeText.includes("p-1"), "🔴 judgeLiftNoticeText quotes the wedge row id — the only handle its instruction can give a reviewer");
  ok(/cannot carry the "This should not have run" button/.test(noticeText), "🔴 judgeLiftNoticeText spells the overrule out, because a tap cannot land here");
  ok(!noticeText.includes(OE_APPROVAL_PREFIX), "🔴 judgeLiftNoticeText carries NO action_id — it must never imply a tap route this surface does not route");
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
  const sid = routineKey("prsess");
  await store.addPendingAction(row({
    id: "p-prsess",
    kind: "pr.open",
    domain: null,
    argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C1", repo: "acme/web", head: "fix/x", base: "main", title: "t", body: "b", headSha: "a".repeat(40), requestedBy: "U_REQUESTER", sessionId: sid }),
  }));
  ok((await handleApprovalPayload(payloadFor("oe_approval:approve_session:p-prsess"), { post })) === true, "approve_session click is owned by the handler");
  const routineMemo = await store.getSessionApproval("default", sid, "pr.open", new Date().toISOString());
  ok(routineMemo?.grantedBy === "U_ORG_ADMIN", "approve_session on a routine's pr.open card sets the routine's memo, attributed to the clicker");
  ok(routineMemo !== null && routineMemo.expiresAt !== ROUTINE_PERMISSION_NO_EXPIRY && Date.parse(routineMemo.expiresAt) - Date.parse(routineMemo.createdAt) === getSettings().approvals.routineGrantTtlHours * 3_600_000, "🔴 OPE-2363: …and the routine grant ends at `approvals.routineGrantTtlHours`, as its label says");
  ok((await readAudit({ org: "default", action: "approval.session_granted" })).some((e) => e.detail?.id === "p-prsess"), "the routine grant is audited (approval.session_granted)");
  for (const [n, key] of [
    ["t", threadKey("prsess")],
    ["d", "oe-grant:slack/T1/D1:dm"],
    ["w", "oe-dom:eng:win:w/eng:oe-sup:g7"],
  ] as const) {
    await store.addPendingAction(row({
      id: `p-prsess-${n}`,
      kind: "pr.open",
      domain: null,
      argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C1", repo: "acme/web", head: `fix/${n}`, base: "main", title: "t", body: "b", headSha: "a".repeat(40), requestedBy: "U_REQUESTER", sessionId: key }),
    }));
    await handleApprovalPayload(payloadFor(`oe_approval:approve_session:p-prsess-${n}`), { post });
    ok((await store.getSessionApproval("default", key, "pr.open", new Date().toISOString())) === null, `🔴 OPE-2363: approve_session on a conversation card (${key}) writes NO memo`);
    ok((await store.getPendingAction("default", `p-prsess-${n}`))?.status === "approved", `…and it degrades to a one-off approve (${key})`);
    ok(!(await readAudit({ org: "default", action: "approval.session_granted" })).some((e) => e.detail?.id === `p-prsess-${n}`), `…and audits NO approval.session_granted (${key})`);
  }

  const beforeExec = memberExecuted.length;
  await store.addPendingAction(row({ id: "p-membersess", kind: "test.member", domain: null, argsJson: JSON.stringify({ sessionId: threadKey("member") }) }));
  await handleApprovalPayload(payloadFor("oe_approval:approve_session:p-membersess", { user: "U_ORG_ADMIN" }), { post });
  ok((await store.getSessionApproval("default", threadKey("member"), "test.member", new Date().toISOString())) === null, "approve_session on a non-pr.open kind sets NO memo (kind-scoped enforcement)");
  ok((await store.getSessionApproval("default", threadKey("member"), "pr.open", new Date().toISOString())) === null, "…and none under pr.open either");
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

  {
    const covArgs = (coverage: unknown, scopeKey = "slack/T2/C_COV") => ({ org: "default", scopeKey, level: "surface" as const, monthlyUsd: 20, reason: "coverage", currentCap: null, currentUsd: null, ...(coverage !== undefined ? { coverage } : {}) });

    const fullCard = spendSet.summarize(covArgs({ measured: "full", windowDays: 30 }) as never);
    ok(
      fullCard.some((l) => /✅ pricing coverage/.test(l) && l.includes("every model this scope ran on in the 30 days before this card was posted carried a committed price")),
      "🔴 OPE-1482: a card for a fully priced scope SAYS full coverage — it does not stay silent, which a pre-OPE-1482 card also did",
    );

    const gapCard = spendSet.summarize(covArgs({ measured: "gap", windowDays: 30, unratedModels: ["test/no-rate-model"], unobservedModels: [] }) as never);
    ok(
      gapCard.some((l) => /⚠ pricing coverage/.test(l) && l.includes("test/no-rate-model") && /\$0/.test(l)),
      "🔴 OPE-1482: a card with an unpriced model NAMES it on the card, and says its calls add $0 to the ledger",
    );
    ok(!gapCard.some((l) => /✅/.test(l)), "OPE-1482: …and a gap card carries no full-coverage tick — the two states never render together");

    const mixedCard = spendSet.summarize(covArgs({ measured: "gap", windowDays: 30, unratedModels: ["test/no-rate-model"], unobservedModels: ["(unstamped)"] }) as never);
    const ratedLine = mixedCard.find((l) => l.includes("test/no-rate-model"));
    const unobservedLine = mixedCard.find((l) => l.includes("(unstamped)"));
    ok(ratedLine !== undefined && unobservedLine !== undefined && ratedLine !== unobservedLine, "🔴 OPE-1482: a mixed gap renders the rated models and the unobserved rows on SEPARATE lines");
    ok(!ratedLine!.includes("(unstamped)"), "🔴 OPE-1482: …the pricing-gap line never names an unobserved row — its remedy is to commit a rate, and there is no model to price");
    ok(/instrumentation gap/.test(unobservedLine!), "🔴 OPE-1482: …and the unobserved line says its remedy is instrumentation, not a rate");

    const unobservedOnly = spendSet.summarize(covArgs({ measured: "gap", windowDays: 30, unratedModels: [], unobservedModels: ["(unknown)"] }) as never);
    ok(unobservedOnly.some((l) => l.includes("(unknown)") && /instrumentation gap/.test(l)), "OPE-1482: an all-unobserved gap still renders its own line");
    ok(!unobservedOnly.some((l) => /carry no committed price/.test(l)), "OPE-1482: …and renders no pricing-gap line, because no model was named");

    const alienCard = spendSet.summarize(covArgs({ measured: "some-future-state", windowDays: 30 }) as never);
    ok(alienCard.some((l) => /coverage state this deploy cannot read/.test(l)), "🔴 OPE-1482: an unrecognised coverage tag renders as unknown, and never throws or renders silence");

    const manyModels = Array.from({ length: 20 }, (_, i) => `test/model-${String(i).padStart(2, "0")}`);
    const cappedCard = spendSet.summarize(covArgs({ measured: "gap", windowDays: 30, unratedModels: manyModels, unobservedModels: [] }) as never);
    const cappedLine = cappedCard.find((l) => /pricing coverage/.test(l))!;
    ok(cappedLine.includes("test/model-07") && !cappedLine.includes("test/model-08"), "🔴 OPE-1482: a long unpriced list names the first 8 models and stops there");
    ok(cappedLine.includes("and 12 more"), "🔴 OPE-1482: …and says how many it did not name, so the reader knows the list is partial");
    ok(cappedCard.join("\n").length < 2000, "🔴 OPE-1482: …keeping the whole card inside a Discord post's 2000-character limit");
    const shortLine = spendSet.summarize(covArgs({ measured: "gap", windowDays: 30, unratedModels: ["a/one", "b/two"], unobservedModels: [] }) as never).find((l) => /pricing coverage/.test(l))!;
    ok(shortLine.includes("a/one, b/two") && !/more/.test(shortLine), "OPE-1482: a short list is named in full, with no truncation tail");

    for (const [label, frozen] of [
      ["full", { measured: "full", windowDays: 30 }],
      ["no-traffic", { measured: "no-traffic", windowDays: 30 }],
      ["gap (rated)", { measured: "gap", windowDays: 30, unratedModels: ["test/no-rate-model"], unobservedModels: [] }],
      ["gap (unobserved)", { measured: "gap", windowDays: 30, unratedModels: [], unobservedModels: ["(unstamped)"] }],
      ["not measured", { measured: "none", why: "the usage ledger could not be read on this turn, so no coverage was measured." }],
    ] as const) {
      const lines = spendSet.summarize(covArgs(frozen) as never).filter((l) => /pricing coverage/i.test(l));
      ok(lines.length > 0, `OPE-1482: the "${label}" state renders at least one coverage line (the anchor check below is not vacuous)`);
      ok(lines.every((l) => l.includes("this card was posted")), `🔴 OPE-1482: every "${label}" coverage line dates its claim to when the card was posted, never the live present`);
    }

    const quietCard = spendSet.summarize(covArgs({ measured: "no-traffic", windowDays: 30 }) as never);
    ok(quietCard.some((l) => /pricing coverage/.test(l) && l.includes("ran no traffic in the 30 days before this card was posted")), "🔴 OPE-1482: a scope with no traffic in the window says so on the card");
    ok(!quietCard.some((l) => /✅/.test(l)), "🔴 OPE-1482: …and never carries the full-coverage tick — an empty window proves nothing about the cap");

    const noneCard = spendSet.summarize(covArgs({ measured: "none", why: "the usage ledger could not be read on this turn, so no coverage was measured." }) as never);
    ok(noneCard.some((l) => /NOT MEASURED/.test(l)), "🔴 OPE-1482: an unmeasurable read renders its own card line, distinct from both full coverage and a gap");

    const legacyCard = spendSet.summarize(covArgs(undefined) as never);
    ok(!legacyCard.some((l) => /pricing coverage/i.test(l)), "OPE-1482: no frozen coverage → no coverage line (a pre-OPE-1482 card and a token-only proposal render unchanged)");

    await spendSet.execute(covArgs({ measured: "gap", windowDays: 30, unratedModels: ["test/no-rate-model"], unobservedModels: [] }, "slack/T2/C_COV_GAP"), "U_ORG_ADMIN");
    await spendSet.execute(covArgs({ measured: "full", windowDays: 30 }, "slack/T2/C_COV_FULL"), "U_ORG_ADMIN");
    await spendSet.execute({ org: "default", scopeKey: "slack/T2/C_COV_TOK", level: "surface" as const, monthlyTokens: 100, reason: "tokens", currentCap: null }, "U_ORG_ADMIN");

    const covAudit = await readAudit({ org: "default", action: "admin.spend.set_limit" });
    const rowFor = (scopeKey: string) => covAudit.find((e) => e.detail?.scopeKey === scopeKey);
    const gapRow = rowFor("slack/T2/C_COV_GAP");
    ok(gapRow?.detail?.pricingCoverage === "gap", "🔴 OPE-1482: the approver's decision row carries the coverage summary");
    ok(JSON.stringify(gapRow?.detail?.unratedModels) === JSON.stringify(["test/no-rate-model"]), "🔴 OPE-1482: …and names the models the approved cap does not meter");
    ok(gapRow?.detail?.unobservedModels === undefined, "OPE-1482: …with the instrumentation list absent when there is none — the two lists stay disjoint in the audit row too");

    await spendSet.execute(covArgs({ measured: "some-future-state", windowDays: 30 }, "slack/T2/C_COV_ALIEN"), "U_ORG_ADMIN");
    const alienRow = (await readAudit({ org: "default", action: "admin.spend.set_limit" })).find((e) => e.detail?.scopeKey === "slack/T2/C_COV_ALIEN");
    ok(alienRow?.detail?.pricingCoverage === "unknown", "🔴 OPE-1482: an unrecognised coverage tag audits as \"unknown\", never as \"full\"");
    await getOperationalStore().clearSpendLimit("default", "slack/T2/C_COV_ALIEN", "surface");

    const fullRow = rowFor("slack/T2/C_COV_FULL");
    ok(fullRow?.detail?.pricingCoverage === "full", "OPE-1482: a fully priced approval records \"full\" — the positive fact, not an absence");
    ok(fullRow?.detail?.unpricedModels === undefined, "OPE-1482: …and names no models, because there are none");

    await spendSet.execute(covArgs({ measured: "no-traffic", windowDays: 30 }, "slack/T2/C_COV_QUIET"), "U_ORG_ADMIN");
    const quietRow = (await readAudit({ org: "default", action: "admin.spend.set_limit" })).find((e) => e.detail?.scopeKey === "slack/T2/C_COV_QUIET");
    ok(quietRow?.detail?.pricingCoverage === "no-traffic", "OPE-1482: an empty-window approval records \"no-traffic\", distinct from \"full\" in the audit trail too");
    await getOperationalStore().clearSpendLimit("default", "slack/T2/C_COV_QUIET", "surface");

    const tokenRow = rowFor("slack/T2/C_COV_TOK");
    ok(tokenRow !== undefined, "OPE-1482: the token-only approval really did write its own audit row — without this the control below would pass on a row that does not exist");
    ok(tokenRow?.detail?.pricingCoverage === undefined, "OPE-1482: a token-only approval records no coverage field — a token cap counts every call, priced or not");

    for (const key of ["slack/T2/C_COV_GAP", "slack/T2/C_COV_FULL", "slack/T2/C_COV_TOK"]) await getOperationalStore().clearSpendLimit("default", key, "surface");
  }

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

  calls.length = 0;
  ok((await handleApprovalPayload(payloadFor("oe_approval:contradict:p-never-existed"), { post })) === true, "an unknown-row contradict click is still owned by the handler");
  ok(calls.every((c) => c.method !== "chat.update"), "🔴 an unknown-row contradict click NEVER edits the message — the judge-lift notice is not erasable by clicking it");
  ok(calls.some((c) => c.method === "chat.postMessage"), "an unknown-row contradict click answers in-thread instead");
  calls.length = 0;
  await handleApprovalPayload(payloadFor("oe_approval:approve:p-never-existed"), { post });
  ok(calls.some((c) => c.method === "chat.update"), "contrast: an unknown-row APPROVE click still replaces the now-moot card");
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
  const store = getOperationalStore();
  const calls: { method: string; body: string }[] = [];
  let ts = 1700;
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: `${ts++}.0` };
  };
  const cards = () => calls.filter((c) => c.method === "chat.postMessage" && !(bodyField(c.body, "text") ?? "").includes("REJECTED")).length;
  const scope = "slack/T2066/C2066";
  const propose = (reason: string, extra: Record<string, unknown> = {}) =>
    requestApproval(
      {
        org: "default",
        kind: "spend.set",
        args: { org: "default", scopeKey: scope, level: "surface", monthlyUsd: 1609, reason, currentCap: null, currentUsd: 50, tainted: false, ...extra },
        scopeKey: scope,
        requestedBy: "U_REQUESTER",
        channelId: "C2066",
        chain: { unattended: false },
      },
      { post },
    );

  ok(actionKind("spend.set")?.proseArgs?.includes("reason") === true, "OPE-2066 fixture: `spend.set` declares `reason` as a prose arg");

  const first = await propose("Rowan asked to raise this channel's monthly USD cap to $1,609.");
  ok(first.deduped !== true, "OPE-2066: the first proposal is a real mint");
  const cardsAfterFirst = cards();
  const second = await propose("Raise only the USD cap to $1,609; leave tokens unchanged.");
  ok(second.deduped === true, "🔴 OPE-2066: the same level, scope and figures with a REWORDED reason is deduped");
  ok(second.id === first.id, "🔴 OPE-2066: the reworded repeat returns the SAME live pendingId");
  ok(cards() === cardsAfterFirst, "🔴 OPE-2066: the reworded repeat posts NO second card");
  ok((await store.listPendingActions("default")).filter((r) => r.scopeKey === scope).length === 1, "OPE-2066: exactly ONE pending row exists for the repeated ask");
  ok(JSON.parse((await store.getPendingAction("default", first.id))!.argsJson).reason === "Rowan asked to raise this channel's monthly USD cap to $1,609.", "OPE-2066: the live card keeps the FIRST proposal's reason — the prose leaves the identity, never the row");

  const otherFigure = await propose("Raise it to $1,700 instead.", { monthlyUsd: 1700 });
  ok(otherFigure.deduped !== true && otherFigure.id !== first.id, "🔴 OPE-2066 NEGATIVE CONTROL: a DIFFERENT $ figure is a new proposal with its own card");
  const addedTokens = await propose("Also cap tokens.", { monthlyTokens: 1 });
  ok(addedTokens.deduped !== true && addedTokens.id !== first.id, "🔴 OPE-2066 NEGATIVE CONTROL: adding a token component is a new proposal with its own card");
  const tainted = await propose("Same ask, tainted turn.", { tainted: true });
  ok(tainted.deduped !== true && tainted.id !== first.id, "🔴 OPE-2066 NEGATIVE CONTROL: a TAINTED repeat never folds onto an untainted card — the approver must see the ⚠");

  await handleApprovalPayload(payloadFor(`oe_approval:reject:${first.id}`, { user: "U_ORG_ADMIN", channel: "C2066", ts: "1700.0" }), { post });
  ok((await store.getPendingAction("default", first.id))?.status === "rejected", "OPE-2066 fixture: the reject decides the first card to rejected");
  const cardsBeforeAgain = cards();
  const again = await propose("Second ask after the reject.");
  ok(again.deduped !== true && again.id !== first.id, "🔴 OPE-2066: a proposal after a REJECT mints a NEW pendingId");
  ok(cards() === cardsBeforeAgain + 1, "🔴 OPE-2066: a proposal after a REJECT posts a new card");
}

{
  const store = getOperationalStore();
  const calls: { method: string; body: string }[] = [];
  let ts = 2071;
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: `${ts++}.0` };
  };
  const cards = () => calls.filter((c) => c.method === "chat.postMessage" && !(bodyField(c.body, "text") ?? "").includes("REJECTED")).length;
  const scope = "slack/T2071/C2071";
  const argsFor = (reason: string, extra: Record<string, unknown> = {}) => ({ org: "default", scopeKey: scope, level: "surface", monthlyUsd: 1609, reason, currentCap: null, currentUsd: 50, tainted: false, ...extra });
  const propose = (reason: string, extra: Record<string, unknown> = {}, over: { scopeKey?: string; channelId?: string } = {}) =>
    requestApproval(
      {
        org: "default",
        kind: "spend.set",
        args: { ...argsFor(reason, extra), ...(over.scopeKey !== undefined ? { scopeKey: over.scopeKey } : {}) },
        scopeKey: over.scopeKey ?? scope,
        requestedBy: "U_REQUESTER",
        channelId: over.channelId ?? "C2071",
        chain: { unattended: false },
      },
      { post },
    );

  const first = await propose("Raise the USD cap to $1,609.");
  ok(first.priorRejection === undefined, "OPE-2071 NEGATIVE CONTROL: a first-ever proposal carries NO prior rejection");
  await handleApprovalPayload(payloadFor(`oe_approval:reject:${first.id}`, { user: "U_ORG_ADMIN", channel: "C2071", ts: "2071.0" }), { post });
  const decided = await store.getPendingAction("default", first.id);
  ok(decided?.status === "rejected" && decided.decidedAt !== null, "OPE-2071 fixture: the admin rejects the first card");

  const cardsBefore = cards();
  const again = await propose("Worker retry, reworded: raise only the USD cap to $1,609.");
  ok(again.deduped !== true && again.id !== first.id, "🔴 OPE-2071: a re-proposal after a REJECT is NOT blocked — it mints a NEW pending id");
  ok(cards() === cardsBefore + 1, "🔴 OPE-2071: a re-proposal after a REJECT still posts its card");
  ok(again.priorRejection?.decidedBy === "U_ORG_ADMIN", `🔴 OPE-2071: the result names WHO rejected the same proposal (${JSON.stringify(again.priorRejection)})`);
  ok(again.priorRejection?.decidedAt === decided?.decidedAt, "🔴 OPE-2071: the result names WHEN it was rejected — the row's own decidedAt");

  const otherFigure = await propose("A different figure.", { monthlyUsd: 1700 });
  ok(otherFigure.priorRejection === undefined, "🔴 OPE-2071 NEGATIVE CONTROL: a DIFFERENT figure is a different proposal — no prior rejection reported");
  const otherRoom = await propose("Same ask, other room.", {}, { channelId: "C2071B" });
  ok(otherRoom.priorRejection === undefined, "🔴 OPE-2071 NEGATIVE CONTROL: the same args in ANOTHER channel carry no prior rejection");

  const ttlMs = getSettings().approvals.ttlHours * 3_600_000;
  const seedRejected = async (id: string, scopeKey: string, channelId: string, decidedAt: string) => {
    await store.addPendingAction(
      row({ id, scopeKey, channelId, argsJson: JSON.stringify({ ...argsFor("seeded"), scopeKey }), status: "rejected", decidedBy: "U_OLD_ADMIN", decidedAt, expiresAt: decidedAt }),
    );
  };
  await seedRejected("p-2071-stale", "slack/T2071/CSTALE", "CSTALE", new Date(Date.now() - ttlMs - 60_000).toISOString());
  const past = await propose("After the TTL.", {}, { scopeKey: "slack/T2071/CSTALE", channelId: "CSTALE" });
  ok(past.priorRejection === undefined, "🔴 OPE-2071: a matching reject OLDER than the approval TTL is ignored");
  const freshAt = new Date(Date.now() - ttlMs + 60_000).toISOString();
  await seedRejected("p-2071-fresh", "slack/T2071/CFRESH", "CFRESH", freshAt);
  const inside = await propose("Inside the TTL.", {}, { scopeKey: "slack/T2071/CFRESH", channelId: "CFRESH" });
  ok(inside.priorRejection?.decidedBy === "U_OLD_ADMIN" && inside.priorRejection.decidedAt === freshAt, "OPE-2071 CONTROL: the same seeded reject just INSIDE the TTL is reported");

  const connectorArgs = (input: Record<string, unknown>) => ({
    org: "default",
    scopeKey: "slack/T2071/CCONN",
    tool: "notion__create_page",
    connection: "notion",
    grain: "call",
    sessionKey: "oe-grant:slack/T2071/CCONN:thread",
    memoKind: `connector.approved:notion__create_page#${JSON.stringify(input).length}`,
    inputPreview: JSON.stringify(input),
    input,
    requestedBy: "U_REQUESTER",
  });
  const proposeConnector = (input: Record<string, unknown>) =>
    requestApproval(
      { org: "default", kind: "op.connector", args: connectorArgs(input), scopeKey: "slack/T2071/CCONN", requestedBy: "U_REQUESTER", channelId: "CCONN", chain: { unattended: false } },
      { post },
    );
  const connFirst = await proposeConnector({ title: "Q3 plan" });
  await handleApprovalPayload(payloadFor(`oe_approval:reject:${connFirst.id}`, { user: "U_ORG_ADMIN", channel: "CCONN", ts: "2390.0" }), { post });
  const connRejected = await store.getPendingAction("default", connFirst.id);
  ok(connRejected?.status === "rejected" && !connRejected.argsJson.includes('"input":'), "OPE-2390 fixture: the rejected connector card no longer stores its input");
  const connAgain = await proposeConnector({ title: "Q3 plan" });
  ok(connAgain.priorRejection?.decidedBy === "U_ORG_ADMIN", `🔴 OPE-2390: the same connector proposal after a reject still reports it (${JSON.stringify(connAgain.priorRejection)})`);
  const connOther = await proposeConnector({ title: "Q4 plan!" });
  ok(connOther.priorRejection === undefined, "OPE-2390 NEGATIVE CONTROL: a connector proposal with a different input reports no prior rejection");
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

  ok(
    (await dispatchApprovalDecisionWake({
      token: "oe-dom:win:win:slack/TW/C_WIN:oe-sup:g1",
      origin: { platform: "slack", channelId: "C_WIN", threadTs: "ANCHOR.W" },
      wakeId: "legacy-no-authority",
      message: "decision recorded",
      domain: "win",
    })) === false,
    "decision authority: a legacy/malformed row with no frozen proposal authority cannot wake the seat through ambient or env identity",
  );

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

    const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
    const { rememberDelegatedTaskBinding, rememberDelegatedTaskWake } = await import("../agent/channels/task-wake.js");
    const { recordRequesterIdentity } = await import("../agent/access/requester-identity.js");
    const { captureApprovalDecisionAuthority } = await import("../agent/approvals/decision-authority.internal.js");
    const { claimTasksForAddressedWake, recordDeliveredWakes } = await import("../agent/access/dispatch-origin-signal.js");
    const { renderWakeEnvelope } = await import("../agent/channels/wake-envelope.js");
    const proposalWake = "wake-proposal-authority";
    const proposalOrigin = { platform: "slack", channelId: "C_WIN", threadTs: "ANCHOR.W" } as const;
    const proposalBinding = {
      org: "default",
      platform: "slack",
      workspace: "TW",
      surface: "C_WIN",
      mode: "channel",
      visibility: "private",
      trust: "internal",
      principalId: "U_ORIGINAL_REQUESTER",
      target: { channelId: "C_WIN" },
      threadTs: "ANCHOR.W",
    } as const;
    await registerUnifiedWakeTarget(store, "default", proposalWake, proposalOrigin, new Date().toISOString(), WIN_TOKEN, true, "direct-mention", "slack/TW/C_WIN", proposalBinding, {
      binding: proposalBinding,
      requester: { kind: "requester", principalId: "U_ORIGINAL_REQUESTER" },
      nonMemberWake: false,
    });
    const siblingWake = "wake-later-nonmember";
    const siblingOrigin = { platform: "slack", channelId: "C_WIN", threadTs: "LATER.B" } as const;
    const siblingBinding = { ...proposalBinding, principalId: "U_LATER", threadTs: "LATER.B" } as const;
    await registerUnifiedWakeTarget(store, "default", siblingWake, siblingOrigin, new Date().toISOString(), WIN_TOKEN, true, undefined, "slack/TW/C_WIN", siblingBinding, {
      binding: siblingBinding,
      requester: { kind: "requester", principalId: "U_LATER" },
      nonMemberWake: true,
    });
    const proposalHookCtx = {
      channel: { kind: "unified" },
      session: {
        turn: { id: "turn-proposal-authority" },
        auth: { current: { attributes: { oe_platform: "slack", oe_wake_id: siblingWake, oe_window_token: WIN_TOKEN, oe_chat_nonmember: "true" } } },
      },
    };
    const proposalCtx = { session: proposalHookCtx.session };
    const proposalEnvelope = renderWakeEnvelope({
      wakeId: proposalWake,
      reason: "mention",
      currentTime: "2026-07-19T00:00:00Z",
      channel: { id: "C_WIN" },
      messages: [
        {
          trigger: true,
          from: "human",
          trust: "peer",
          author: "original requester",
          authorId: "U_ORIGINAL_REQUESTER",
          body: "please propose this action",
          sentAt: "2026-07-18T23:59:59Z",
          id: "proposal-message",
        },
      ],
    });
    const siblingEnvelope = renderWakeEnvelope({
      wakeId: siblingWake,
      reason: "channel-activity",
      currentTime: "2026-07-19T00:00:01Z",
      channel: { id: "C_WIN" },
      messages: [{ trigger: true, from: "human", trust: "unauth", author: "later outsider", authorId: "U_LATER", body: "unrelated later delivery", sentAt: "2026-07-19T00:00:00Z", id: "later-message" }],
    });
    const coalescedEnvelope = `${proposalEnvelope}\n${siblingEnvelope}`;
    const proposed = await inSession(async () => {
      recordDeliveredWakes("turn-proposal-authority", coalescedEnvelope);
      claimTasksForAddressedWake("turn-proposal-authority", proposalWake);
      recordRequesterIdentity(proposalHookCtx as never, "turn-proposal-authority", coalescedEnvelope);
      return requestApproval(
        {
          org: "default",
          kind: "test.member",
          args: { marker: "decision-authority" },
          scopeKey: "slack/TW/C_WIN",
          domain: "win",
          requestedBy: "U_ORIGINAL_REQUESTER",
          channelId: "C_WIN",
          threadTs: "ANCHOR.W",
          postedTo: "slack/TW/C_WIN",
          chain: { unattended: false },
        },
        { postCard: async () => "proposal-card-ts", authorityContext: proposalCtx as never },
      );
    });

    const incompleteWake = "wake-proposal-no-binding";
    await registerUnifiedWakeTarget(store, "default", incompleteWake, proposalOrigin, new Date().toISOString(), WIN_TOKEN, true, "direct-mention", "slack/TW/C_WIN");
    const incompleteCtx = {
      ...proposalCtx,
      session: {
        ...proposalCtx.session,
        auth: { current: { attributes: { ...proposalCtx.session.auth.current.attributes, oe_wake_id: incompleteWake } } },
      },
    };
    const incompleteEnvelope = renderWakeEnvelope({
      wakeId: incompleteWake,
      reason: "mention",
      currentTime: "2026-07-19T00:00:01Z",
      channel: { id: "C_WIN" },
      messages: [{ trigger: true, from: "human", trust: "peer", author: "original requester", authorId: "U_ORIGINAL_REQUESTER", body: "try again", sentAt: "2026-07-19T00:00:00Z", id: "proposal-message-2" }],
    });
    await assert.rejects(
      () =>
        inSession(async () => {
          recordDeliveredWakes("turn-proposal-authority", incompleteEnvelope);
          return captureApprovalDecisionAuthority(incompleteCtx as never);
        }),
      /no complete frozen binding/,
      "decision authority: an exact delivered wake without a durable binding fails closed",
    );
    n++;

    const childCtx = {
      channel: { kind: "subagent", continuationToken: "subagent:parent-proposal:call-proposal" },
      session: {
        id: "child-proposal",
        parent: { sessionId: "parent-proposal", callId: "call-proposal", rootSessionId: "parent-proposal" },
        turn: { id: "turn-child-proposal", sequence: 0 },
        auth: {
          current: {
            attributes: {
              oe_platform: "notion",
              workspace_id: "N_OTHER",
              page_id: "P_OTHER",
              discussion_id: "D_OTHER",
              oe_window_token: WIN_TOKEN,
              oe_requester: "U_LATER",
              oe_chat_nonmember: "true",
            },
            principalId: "U_LATER",
          },
        },
      },
    };
    await rememberDelegatedTaskWake("default", "parent-proposal", "call-proposal", proposalWake);
    const childAuthority = await captureApprovalDecisionAuthority(childCtx as never);
    ok(JSON.stringify(childAuthority?.binding) === JSON.stringify(proposalBinding), "decision authority: a child proposal resolves its exact parent dispatch binding through parent+call, not copied current auth");
    ok(childAuthority?.requester.kind === "requester" && childAuthority.requester.principalId === "U_ORIGINAL_REQUESTER", "decision authority: a child proposal keeps the dispatch requester's identity");
    ok(childAuthority?.nonMemberWake === false, "decision authority: a child proposal keeps dispatch-time membership rather than later child auth");

    const childProposed = await requestApproval(
      {
        org: "default",
        kind: "test.member",
        args: { marker: "child-decision-authority" },
        scopeKey: "slack/TW/C_WIN",
        domain: "win",
        requestedBy: "U_ORIGINAL_REQUESTER",
        channelId: "C_WIN",
        threadTs: "ANCHOR.W",
        postedTo: "slack/TW/C_WIN",
        chain: { unattended: false },
      },
      { postCard: async () => "child-proposal-card-ts", authorityContext: childCtx as never },
    );
    wakes.length = 0;
    await handleApprovalPayload(winPayload(`oe_approval:reject:${childProposed.id}`, { user: "U_ORG_ADMIN" }), { post, decisionWake });
    ok(wakes.length === 1 && JSON.stringify(wakes[0]!.binding) === JSON.stringify(proposalBinding), "decision authority: a child proposal's click resumes the conversational parent destination");

    const missingChild = {
      ...childCtx,
      session: {
        ...childCtx.session,
        parent: { sessionId: "parent-proposal", callId: "call-missing", rootSessionId: "parent-proposal" },
      },
    };
    await assert.rejects(
      () => captureApprovalDecisionAuthority(missingChild as never),
      /delegated child has no exact wake-backed dispatch authority/,
      "decision authority: a child with no durable dispatch pointer fails closed despite copied window/auth stamps",
    );
    n++;

    await rememberDelegatedTaskBinding(
      "default",
      "parent-proposal",
      "call-binding-only",
      proposalBinding,
      { kind: "requester", principalId: "U_ORIGINAL_REQUESTER" },
      false,
    );
    const bindingOnlyChild = {
      ...childCtx,
      session: {
        ...childCtx.session,
        parent: { sessionId: "parent-proposal", callId: "call-binding-only", rootSessionId: "parent-proposal" },
      },
    };
    await assert.rejects(
      () => captureApprovalDecisionAuthority(bindingOnlyChild as never),
      /delegated child has no exact wake-backed dispatch authority/,
      "decision authority: a unified binding-only child cannot invent a wake-backed continuation destination",
    );
    n++;

    const nativeBindingOnlyChild = {
      ...bindingOnlyChild,
      channel: { kind: "subagent", continuationToken: "subagent:parent-proposal:call-binding-only" },
      session: {
        ...bindingOnlyChild.session,
        auth: {
          current: {
            attributes: { oe_platform: "notion", workspace_id: "N_OTHER", page_id: "P_OTHER", discussion_id: "D_OTHER" },
            principalId: "U_LATER",
          },
        },
      },
    };
    ok((await captureApprovalDecisionAuthority(nativeBindingOnlyChild as never)) === undefined, "decision authority: a true native child has no unified continuation to freeze and remains card-capable");
    const nativeProposed = await requestApproval(
      {
        org: "default",
        kind: "test.member",
        args: { marker: "native-child-card-only" },
        scopeKey: "slack/TW/C_WIN",
        domain: "win",
        requestedBy: "U_ORIGINAL_REQUESTER",
        channelId: "C_WIN",
        threadTs: "ANCHOR.W",
        postedTo: "slack/TW/C_WIN",
        chain: { unattended: false },
      },
      { postCard: async () => "native-child-card-ts", authorityContext: nativeBindingOnlyChild as never },
    );
    wakes.length = 0;
    await handleApprovalPayload(winPayload(`oe_approval:reject:${nativeProposed.id}`, { user: "U_ORG_ADMIN" }), { post, decisionWake });
    ok(
      wakes.length === 1 && wakes[0]!.binding === undefined && wakes[0]!.requester === undefined,
      "decision authority: a native child card resolves without inventing unified authority (the production dispatcher refuses this authority-less optional wake)",
    );

    wakes.length = 0;
    await handleApprovalPayload(winPayload(`oe_approval:reject:${proposed.id}`, { user: "U_ORG_ADMIN" }), { post, decisionWake });
    ok(wakes.length === 1, "decision authority: the real proposal+click path emits one continuation");
    ok(JSON.stringify(wakes[0]!.binding) === JSON.stringify(proposalBinding), "decision authority: the continuation carries the exact binding frozen from the proposing wake row");
    ok(
      wakes[0]!.requester?.kind === "requester" && wakes[0]!.requester.principalId === "U_ORIGINAL_REQUESTER",
      "decision authority: the original authenticated requester survives the click",
    );
    ok(
      wakes[0]!.requester?.kind === "requester" && wakes[0]!.requester.principalId !== "U_ORG_ADMIN",
      "decision authority: the approving actor never replaces the requester",
    );
    ok(wakes[0]!.nonMemberWake === false, "decision authority: later wake B's non-member mark cannot taint selected proposal wake A");

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
    ok(!wakes[0]!.message.includes("ALREADY RUN"), "decision wake: a REJECTED wake never claims an act already ran");
    ok(wakes[0]!.wakeId === "wake-fixed", "decision wake: the host-minted wakeId rides the dispatch (reply-target map key)");

    await store.addPendingAction(winRow({ id: "p-win-approve", argsJson: JSON.stringify({ org: "default", scopeKey: "slack/TW/C_WIN", level: "surface", monthlyTokens: 800, currentCap: null }) }));
    wakes.length = 0;
    await handleApprovalPayload(winPayload("oe_approval:approve:p-win-approve"), { post, decisionWake });
    ok(wakes.length === 1 && wakes[0]!.message.includes("APPROVED"), "decision wake: an APPROVE in a window domain emits one wake carrying the approved outcome");
    ok(wakes[0]!.message.includes("spend limit set to"), `decision wake: the approved wake carries the EXECUTOR's own outcome line (${wakes[0]!.message})`);
    ok(wakes[0]!.message.includes("ALREADY RUN"), "decision wake: the approved wake states the act already ran");
    ok(wakes[0]!.message.includes("NOT delegate it again"), "decision wake: the approved wake forbids re-delegating the same act");
    await store.clearSpendLimit("default", "slack/TW/C_WIN", "surface");

    registerActionKind({
      kind: "test.throws",
      policy: "admin",
      summarize: () => ["a kind whose execute always throws"],
      execute: async () => {
        throw new Error("transport refused the send");
      },
    });
    await store.addPendingAction(winRow({ id: "p-win-fail", kind: "test.throws", argsJson: "{}" }));
    wakes.length = 0;
    await handleApprovalPayload(winPayload("oe_approval:approve:p-win-fail"), { post, decisionWake });
    ok(wakes.length === 1, "decision wake: a FAILED execute still emits exactly one wake");
    ok(wakes[0]!.message.includes("RAN AND FAILED"), `decision wake: a failed execute says the act failed (${wakes[0]!.message})`);
    ok(wakes[0]!.message.includes("transport refused the send"), "decision wake: a failed execute carries the failure reason");
    ok(!wakes[0]!.message.includes("ALREADY RUN"), "decision wake: a failed execute NEVER claims the act already ran");
    ok(wakes[0]!.message.includes("attempt it again"), "decision wake: a failed execute leaves the seat free to retry");

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

    const { dmWindowRegistryKey } = await import("../agent/channels/unified-supervisor.js");
    const DM_SURFACE = "slack/TW/D_DMSEAT1";
    const DM_TOKEN = "oe-dom:oe-dm/slack/TW/D_DMSEAT1:oe-sup:g1-abc123";
    const dmGrain = supervisorGrainFor(DM_SURFACE, getConfig().loadDomains());
    ok(dmGrain.registryKey !== dmWindowRegistryKey(DM_SURFACE), `DM setup: the domain grain does NOT name the DM seat's row (${dmGrain.registryKey}) — the gap the DM arm closes`);
    await store.rotateChannelSession("default", dmWindowRegistryKey(DM_SURFACE), DM_TOKEN, new Date().toISOString());
    const dmRow = (over: Partial<PendingActionRow>) =>
      row({
        scopeKey: DM_SURFACE,
        channelId: "D_DMSEAT1",
        threadTs: null,
        messageTs: "333.444",
        domain: null,
        argsJson: JSON.stringify({ org: over.org ?? "default", scopeKey: DM_SURFACE, level: "surface", monthlyTokens: 400, currentCap: null }),
        ...over,
      });
    const dmPayload = (actionId: string, channel = "D_DMSEAT1") => winPayload(actionId, { channel, team: "TW" });

    await store.addPendingAction(dmRow({ id: "p-dm-approve" }));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:approve:p-dm-approve"), { post, decisionWake });
    ok(wakes.length === 1, `decision wake (DM): an APPROVE on a DM card emits EXACTLY ONE decision wake (got ${wakes.length})`);
    ok(wakes[0]?.token === DM_TOKEN, "decision wake (DM): the wake targets the DM seat's CURRENT registry token");
    ok(wakes[0]?.domain === "oe-dm/slack/TW/D_DMSEAT1", "decision wake (DM): the wake carries the DM's own pseudo-domain");
    const oDm = wakes[0] ? slackOrigin(wakes[0].origin) : null;
    ok(!!oDm && oDm.channelId === "D_DMSEAT1", "decision wake (DM): origin = the DM the card lives in");
    ok(!!wakes[0] && wakes[0].message.includes("APPROVED") && wakes[0].message.includes("ALREADY RUN"), "decision wake (DM): the approved wake states the outcome and that the act already ran");
    const dmAudit = (await readAudit({ org: "default", action: "approval.decision_wake" })).find((e) => e.detail?.id === "p-dm-approve");
    ok(dmAudit?.detail?.delivered === true && dmAudit.detail.domain === "oe-dm/slack/TW/D_DMSEAT1", "decision wake (DM): approval.decision_wake records delivered:true on the DM pseudo-domain");
    await store.clearSpendLimit("default", DM_SURFACE, "surface");

    await store.addPendingAction(dmRow({ id: "p-dm-reject" }));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:reject:p-dm-reject"), { post, decisionWake });
    ok(wakes.length === 1 && wakes[0]!.message.includes("REJECTED") && !wakes[0]!.message.includes("ALREADY RUN"), "decision wake (DM): a REJECT emits one wake that says rejected and never claims the act ran");

    await store.addPendingAction(dmRow({ id: "p-dm-noseat", scopeKey: "slack/TW/D_NOSEAT", channelId: "D_NOSEAT", argsJson: JSON.stringify({ org: "default", scopeKey: "slack/TW/D_NOSEAT", level: "surface", monthlyTokens: 1, currentCap: null }) }));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:reject:p-dm-noseat", "D_NOSEAT"), { post, decisionWake });
    ok(wakes.length === 0, "decision wake (DM): a DM with no live seat row emits no wake");

    const FENCE_SURFACE = "slack/TW/D_FENCE";
    const fenceRow = (id: string) =>
      dmRow({ id, scopeKey: FENCE_SURFACE, channelId: "D_FENCE", argsJson: JSON.stringify({ org: "default", scopeKey: FENCE_SURFACE, level: "surface", monthlyTokens: 1, currentCap: null }) });
    await store.rotateChannelSession("default", dmWindowRegistryKey(FENCE_SURFACE), DM_TOKEN, new Date().toISOString());
    await store.addPendingAction(fenceRow("p-dm-fence-other"));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:reject:p-dm-fence-other", "D_FENCE"), { post, decisionWake });
    ok(wakes.length === 0, "decision wake (DM fence): a seat row whose token anchors to ANOTHER DM is never woken");
    await store.rotateChannelSession("default", dmWindowRegistryKey(FENCE_SURFACE), "oe-dom:oe-dm/slack/TW/D_FENCE:win:t/abc:oe-sup:g0", new Date().toISOString());
    await store.addPendingAction(fenceRow("p-dm-fence-task"));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:reject:p-dm-fence-task", "D_FENCE"), { post, decisionWake });
    ok(wakes.length === 0, "decision wake (DM fence): a DM-anchored WORKER token on the row is never treated as the DM seat");
    await store.rotateChannelSession("default", dmWindowRegistryKey(FENCE_SURFACE), "oe-dom:oe-dm/slack/TW/D_FENCE:oe-sup:g2-def456", new Date().toISOString());
    await store.addPendingAction(fenceRow("p-dm-fence-own"));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:reject:p-dm-fence-own", "D_FENCE"), { post, decisionWake });
    ok(wakes.length === 1 && wakes[0]!.token === "oe-dom:oe-dm/slack/TW/D_FENCE:oe-sup:g2-def456", "decision wake (DM fence): positive control — the same row with its OWN seat token is woken");

    const opRow = (id: string) =>
      dmRow({
        id,
        kind: "op.connector",
        argsJson: JSON.stringify({
          org: "default",
          scopeKey: DM_SURFACE,
          tool: "notion__notion-create-pages",
          connection: "notion",
          grain: "call",
          sessionKey: `conv:${DM_SURFACE}`,
          memoKind: `connector-op:${id}`,
          inputPreview: '{"title":"T"}',
          requestedBy: "U_ORG_ADMIN",
        }),
      });
    await store.addPendingAction(opRow("p-dm-op-approve"));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:approve:p-dm-op-approve"), { post, decisionWake });
    const opMsg = wakes[0]?.message ?? "";
    ok(wakes.length === 1 && wakes[0]!.token === DM_TOKEN, `decision wake (op.connector): an APPROVE emits ONE wake into the DM seat (got ${wakes.length})`);
    ok(opMsg.includes("HAS NOT RUN"), "decision wake (op.connector): the approved wake says the write has NOT run");
    ok(!opMsg.includes("ALREADY RUN"), "decision wake (op.connector): the approved wake never claims the write already ran");
    ok(opMsg.includes("`taskId`") && opMsg.includes("call the op again with exactly the same input"), "decision wake (op.connector): the wake sends the asking job back to call the op again");
    ok(!opMsg.includes("cancel it ("), "decision wake (op.connector): the wake never tells the seat to cancel the job that must make the call");

    await store.addPendingAction(opRow("p-dm-op-reject"));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:reject:p-dm-op-reject"), { post, decisionWake });
    const rejMsg = wakes[0]?.message ?? "";
    ok(wakes.length === 1 && rejMsg.includes("REJECTED"), "decision wake (op.connector): a REJECT emits one wake that says rejected");
    ok(!rejMsg.includes("call the op again") && !rejMsg.includes("HAS NOT RUN") && !rejMsg.includes("ALREADY RUN"), "decision wake (op.connector): a rejected card asks for no call and claims no run");
    const memo = await store.getSessionApproval("default", `conv:${DM_SURFACE}`, "connector-op:p-dm-op-reject", new Date().toISOString());
    ok(memo === null, "decision wake (op.connector): a rejected card writes no one-call memo, so nothing can run");
    const approvedMemo = await store.getSessionApproval("default", `conv:${DM_SURFACE}`, "connector-op:p-dm-op-approve", new Date().toISOString());
    ok(approvedMemo !== null, "decision wake (op.connector): positive control — the approved card wrote its one-call memo");

    const storedRow = (id: string) => {
      const r = opRow(id);
      return { ...r, argsJson: JSON.stringify({ ...JSON.parse(r.argsJson), input: { title: "T", allow_async: false } }) };
    };
    await store.addPendingAction(storedRow("p-dm-op-replay"));
    wakes.length = 0;
    await handleApprovalPayload(dmPayload("oe_approval:approve:p-dm-op-replay"), { post, decisionWake });
    const replayMsg = wakes[0]?.message ?? "";
    ok(wakes.length === 1 && replayMsg.includes("HAS NOT RUN"), "decision wake (op.connector replay): an APPROVE emits one wake that says the write has NOT run");
    ok(
      replayMsg.includes("`connection` set to `notion`, `tool` set to `notion-create-pages`, and `input` set to an object whose ONLY key is `oe_approved_card`, with the card id `p-dm-op-replay` as its value"),
      `decision wake (op.connector replay): the wake names the stored call's target and the card id (${replayMsg.slice(0, 400)})`,
    );
    ok(!replayMsg.includes("call the op again with exactly the same input"), "decision wake (op.connector replay): the wake never asks for a rebuilt call");
    ok(!opMsg.includes("oe_approved_card"), "decision wake (op.connector): control — a card with no stored input names no replay");

    await store.addPendingAction(storedRow("p-dm-op-reject-stored"));
    await handleApprovalPayload(dmPayload("oe_approval:reject:p-dm-op-reject-stored"), { post, decisionWake });
    const rejectedStored = await store.getPendingAction("default", "p-dm-op-reject-stored");
    const rejectedArgs = JSON.parse(rejectedStored?.argsJson ?? "{}") as Record<string, unknown>;
    ok(rejectedStored?.status === "rejected", "op.connector retention: fixture — the click rejected the stored-input card");
    ok(!("input" in rejectedArgs) && rejectedArgs["inputCleared"] === true, `🔴 op.connector retention: a REJECTED card no longer stores its input (${rejectedStored?.argsJson})`);
    ok(rejectedArgs["inputPreview"] === '{"title":"T"}' && rejectedArgs["memoKind"] === "connector-op:p-dm-op-reject-stored", "op.connector retention: the rejected card keeps its preview and memo kind for audit");
    const approvedStored = JSON.parse((await store.getPendingAction("default", "p-dm-op-replay"))?.argsJson ?? "{}") as Record<string, unknown>;
    ok("input" in approvedStored && approvedStored["inputCleared"] === undefined, "op.connector retention: NEGATIVE CONTROL — an APPROVED card that has not replayed keeps its input");
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

  ok(actionKind("webhook.rotate")?.beneficiaryClicker === true, "clicker gate leg B: webhook.rotate carries beneficiaryClicker (its execute mints a live signing secret and destroys the one in use; the reveal goes to the ASKER — OPE-327)");
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

{
  const store = getOperationalStore();
  const { resetTurnClock } = await import("../agent/observability/turn-clock.js");
  let ts = 900;
  const post = async () => ({ ok: true, ts: `${ts++}.0` }) as never;
  const proposal = (coverage: unknown) => ({
    org: "default",
    kind: "spend.set" as const,
    args: { org: "default", scopeKey: "slack/T12/C12", level: "surface", monthlyUsd: 250, currentCap: null, currentUsd: null, coverage },
    scopeKey: "slack/T12/C12",
    requestedBy: "U_REQUESTER",
    channelId: "C12",
    chain: { unattended: false },
  });
  const inTurn = <T>(sessionId: string, turnId: string, fn: () => Promise<T>): Promise<T> =>
    inSession(async () => {
      resetTurnClock(turnId, Date.now(), sessionId);
      return fn();
    });

  ok(actionKind("spend.set")?.volatileArgs?.includes("coverage") === true, "OPE-1556 fixture: `spend.set` declares `coverage` as its one volatile (measured) arg");

  const delivery1 = await inTurn("sess-redeliver", "turn_3", () => requestApproval(proposal({ measured: "full", windowDays: 30 }), { post }));
  const delivery2 = await inTurn("sess-redeliver", "turn_3", () => requestApproval(proposal({ measured: "gap", windowDays: 30, unratedModels: ["m-1"], unobservedModels: [] }), { post }));
  ok(delivery1.deduped !== true, "OPE-1556 fixture: the first delivery is a real mint");
  ok(delivery2.deduped === true && delivery2.id === delivery1.id, "🔴 OPE-1556: a REDELIVERED step body that re-measured coverage lands on the card it already minted — one ask, one card");
  ok(
    (await store.listPendingActions("default")).filter((r) => r.scopeKey === "slack/T12/C12").length === 1,
    "🔴 OPE-1556: exactly ONE pending row exists for the redelivered proposal — the second clickable card is gone",
  );

  const reask = await inTurn("sess-redeliver", "turn_4", () => requestApproval(proposal({ measured: "gap", windowDays: 30, unratedModels: ["m-2"], unobservedModels: [] }), { post }));
  ok(reask.deduped !== true && reask.id !== delivery1.id, "🔴 OPE-1556 NEGATIVE CONTROL: a genuine re-ask in a LATER turn still mints its OWN card with its own freshly-measured coverage");

  const otherFigure = await inTurn("sess-redeliver", "turn_3", () =>
    requestApproval({ ...proposal({ measured: "full", windowDays: 30 }), args: { ...proposal(undefined).args, monthlyUsd: 999, coverage: { measured: "full", windowDays: 30 } } }, { post }),
  );
  ok(otherFigure.deduped !== true && otherFigure.id !== delivery1.id, "🔴 OPE-1556: a DIFFERENT proposed figure in the same turn is a different ask — the redelivery key drops the measurement, never the request");

  const minted = await store.getPendingAction("default", delivery1.id);
  ok(
    (JSON.parse(minted!.argsJson) as { coverage?: { measured?: string } }).coverage?.measured === "full",
    "🔴 OPE-1556: the frozen row still carries the coverage measured when the approver was asked — only the dedup KEY drops it",
  );

  const raced = (coverage: unknown) => {
    const p = proposal(coverage);
    return { ...p, args: { ...p.args, monthlyUsd: 777 } };
  };
  const [raceA, raceB] = await Promise.all([
    inTurn("sess-race", "turn_9", () => requestApproval(raced({ measured: "full", windowDays: 30 }), { post })),
    inTurn("sess-race", "turn_9", () => requestApproval(raced({ measured: "gap", windowDays: 30, unratedModels: ["m-3"], unobservedModels: [] }), { post })),
  ]);
  ok(raceA!.id === raceB!.id, "🔴 OPE-1556: two deliveries IN FLIGHT AT ONCE in one turn land on ONE card — the redelivery arm folds them although their measured coverage differs");

  const noTurnA = await inSession(() => requestApproval(proposal({ measured: "no-traffic", windowDays: 30 }), { post }));
  const noTurnB = await inSession(() => requestApproval(proposal({ measured: "none", why: "ledger unreachable" }), { post }));
  ok(noTurnA.id !== noTurnB.id && noTurnB.deduped !== true, "OPE-1556: with no readable (session, turn) the guard is inert — two differing measurements mint two cards, exactly as before this shipped");
}

{
  const store = getOperationalStore();
  const { RESUME_TOOL, TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
  const entryFor = async (action: string, id: string) => (await readAudit({ org: "default", action })).find((e) => e.detail?.id === id);
  const haltRows = (address: { orgWide: true } | { orgWide: false; level: "surface" | "workspace" | "domain" | "user"; scopeKey: string }) => ({
    rows: async () => [{ org: "default", address, active: true, setAt: "2026-09-09T00:00:00Z" }],
  });
  const haltUnreadable = {
    rows: async (): Promise<never> => {
      throw new Error("halt store outage");
    },
  };

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-halt-pre", kind: "test.member", argsJson: "{}", domain: null }));
  const halted = await resolveApprovalClick({
    org: "default",
    id: "p-halt-pre",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltRows({ orgWide: true }),
  });
  ok(halted.outcome === "halted", "🔴 OPE-1604: an approve click on a PRE-HALT card during an org-wide halt resolves `halted`");
  ok(memberExecuted.length === 0, "🔴 OPE-1604: and the kind's execute NEVER RAN — the refusal is the point, not the render");

  const afterHalt = await store.getPendingAction("default", "p-halt-pre");
  ok(afterHalt?.status === "pending" && afterHalt.decidedBy === null, "🔴 OPE-1604: the halted click edits NO row — the pending stays pending, undecided, for the same person to click after `resume`");

  const rHalted = await entryFor("approval.denied", "p-halt-pre");
  ok(rHalted?.detail?.reason === "halted", "OPE-1604: the refusal writes the shared `approval.denied` row with reason `halted`");
  ok(rHalted?.detail?.halt === "orgWide", "OPE-1604: and the row names WHICH halt refused it (haltAuditDetail), so an incident review can join the refusal to the stop");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-halt-clear", kind: "test.member", argsJson: "{}", domain: null }));
  const cleared = await resolveApprovalClick({
    org: "default",
    id: "p-halt-clear",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    halt: { rows: async () => [] },
  });
  ok(cleared.outcome === "decided", "🔴 OPE-1604 NEGATIVE CONTROL: with NO halt row the identical click decides normally");
  ok(memberExecuted.includes("U_RANDOM_MEMBER"), "🔴 OPE-1604 NEGATIVE CONTROL: and the kind's execute DID run — the refusal above is the halt, not a broken click path");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-halt-elsewhere", kind: "test.member", argsJson: "{}", domain: null }));
  const elsewhere = await resolveApprovalClick({
    org: "default",
    id: "p-halt-elsewhere",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltRows({ orgWide: false, level: "surface", scopeKey: "slack/T1/C-SOMEWHERE-ELSE" }),
  });
  ok(elsewhere.outcome === "decided" && memberExecuted.includes("U_RANDOM_MEMBER"), "🔴 OPE-1604: a surface halt at an UNRELATED key does not refuse this click — the arrow reads the row's own address");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-halt-surface", kind: "test.member", argsJson: "{}", domain: null }));
  const atSurface = await resolveApprovalClick({
    org: "default",
    id: "p-halt-surface",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltRows({ orgWide: false, level: "surface", scopeKey: "slack/T1/C1" }),
  });
  ok(atSurface.outcome === "halted" && memberExecuted.length === 0, "🔴 OPE-1604: a surface halt at the ROW'S OWN surface refuses the click");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-halt-unreadable", kind: "test.member", argsJson: "{}", domain: null }));
  const unreadable = await resolveApprovalClick({
    org: "default",
    id: "p-halt-unreadable",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltUnreadable,
  });
  ok(unreadable.outcome === "halted" && memberExecuted.length === 0, "🔴 OPE-1604: an UNREADABLE halt store refuses the click — fail-closed, like every other arrow");
  ok(
    unreadable.outcome === "halted" && unreadable.notice.includes("could not be read"),
    "🔴 OPE-1604: and the notice names the fail-closed case, so nobody reads a store outage as an operator's stop",
  );
  ok((await entryFor("approval.denied", "p-halt-unreadable"))?.detail?.halt === "unreadable", "OPE-1604: the audit row distinguishes `unreadable` from a real address");

  await store.addPendingAction(row({ id: "p-halt-reject", kind: "test.member", argsJson: "{}", domain: null }));
  const rejectedUnderHalt = await resolveApprovalClick({
    org: "default",
    id: "p-halt-reject",
    decision: "reject",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltRows({ orgWide: true }),
  });
  ok(rejectedUnderHalt.outcome === "halted", "🔴 OPE-1604: a REJECT click is refused during a halt too — it consumes the row, which is an edit");
  ok((await store.getPendingAction("default", "p-halt-reject"))?.status === "pending", "OPE-1604: …and that row is untouched as well");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-halt-requester", kind: "test.member", argsJson: "{}", domain: null }));
  const onRequester = await resolveApprovalClick({
    org: "default",
    id: "p-halt-requester",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltRows({ orgWide: false, level: "user", scopeKey: "user:slack/T1/U_REQUESTER" }),
  });
  ok(onRequester.outcome === "halted" && memberExecuted.length === 0, "🔴 OPE-1604: a `user` halt on the row's REQUESTER refuses the click — the person axis is namable and it is the requester's");

  memberExecuted = [];
  await store.addPendingAction(row({ id: "p-halt-clicker", kind: "test.member", argsJson: "{}", domain: null }));
  const onClicker = await resolveApprovalClick({
    org: "default",
    id: "p-halt-clicker",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltRows({ orgWide: false, level: "user", scopeKey: "user:slack/T1/U_RANDOM_MEMBER" }),
  });
  ok(onClicker.outcome === "decided" && memberExecuted.includes("U_RANDOM_MEMBER"), "🔴 OPE-1604 STATED LIMIT: a `user` halt on the CLICKER alone does NOT reach this arrow — measured, not merely written down");

  const liftKind = (TOOL_CONSEQUENCE[RESUME_TOOL]?.via as { kind: string; action?: string }).action!;
  let lifted = 0;
  registerActionKind({
    kind: liftKind,
    policy: "admin",
    summarize: () => ["lift the halt"],
    async execute() {
      lifted++;
      return "halt lifted";
    },
  });
  await store.addPendingAction(row({ id: "p-halt-lift", kind: liftKind, argsJson: "{}", domain: null }));
  const lift = await resolveApprovalClick({
    org: "default",
    id: "p-halt-lift",
    decision: "approve",
    clickerId: "U_ORG_ADMIN",
    clickerPlatform: "slack",
    clickerTenant: "T1",
    halt: haltRows({ orgWide: true }),
  });
  ok(lift.outcome === "decided" && lifted === 1, `🔴 OPE-1604: the LIFT card (\`${liftKind}\`) still decides and EXECUTES during an org-wide halt — a halt can never deny its own lift`);

  lifted = 0;
  await store.addPendingAction(row({ id: "p-halt-lift-unreadable", kind: liftKind, argsJson: "{}", domain: null }));
  const liftUnreadable = await resolveApprovalClick({ org: "default", id: "p-halt-lift-unreadable", decision: "approve", clickerId: "U_ORG_ADMIN", clickerPlatform: "slack", clickerTenant: "T1", halt: haltUnreadable });
  ok(liftUnreadable.outcome === "decided" && lifted === 1, "🔴 OPE-1604: the lift card decides even when the halt store cannot be READ — the fail-closed arrow never closes over the lift");

  ok(RESUME_TOOL === "resume" && liftKind.length > 0, "OPE-1604: the exempt kind is read from TOOL_CONSEQUENCE's own row for the lift verb — one spelling, not two");

  await store.addPendingAction(row({ id: "p-halt-venue", kind: "test.member", argsJson: "{}", domain: null, scopeKey: "linear/WS9/ISSUE-42", channelId: "C_ENG", postedTo: null }));
  await resolveApprovalClick({
    org: "default",
    id: "p-halt-venue",
    decision: "approve",
    clickerId: "U_RANDOM_MEMBER",
    clickerPlatform: "slack",
    clickerTenant: "T1",
    clickContext: { surfaceKey: "slack/T1/C_INTRUDER" },
    halt: haltRows({ orgWide: true }),
  });
  const rVenue = await entryFor("approval.denied", "p-halt-venue");
  ok(rVenue?.detail?.reason === "halted", "OPE-1604 fixture: the foreign-room click during a halt is refused by the HALT arrow, which runs first");
  ok(
    rVenue?.detail?.venuePlatform === "linear" && rVenue?.detail?.venueWorkspace === "WS9",
    "🔴 OPE-1604: the halted refusal names the ROW's own venue, never the unverified room the click came from — an intruder's workspace must not be recorded as the card's",
  );

  await store.addPendingAction(
    row({ id: "p-halt-contradict", kind: "test.member", argsJson: "{}", domain: null, status: "approved", decidedBy: "chain:judge", decidedAt: "2026-09-09T00:00:00Z", expiresAt: "2026-09-09T00:00:00Z" }),
  );
  const contradicted = await resolveApprovalClick({
    org: "default",
    id: "p-halt-contradict",
    decision: "contradict",
    clickerId: "U_RANDOM_MEMBER",
    halt: haltRows({ orgWide: true }),
  });
  ok(contradicted.outcome === "contradicted", "🔴 OPE-1604: a CONTRADICT click still resolves during a halt — the exempt verb, because it executes nothing and edits no pending row");
}

{
  const store = getOperationalStore();

  const prExecuted: string[] = [];
  registerActionKind({
    kind: "pr.open",
    policy: "member",
    summarize: () => ["open a pull request"],
    async execute(args: unknown, decidedBy: string) {
      prExecuted.push(String((args as { what?: unknown }).what));
      return `published by ${decidedBy}`;
    },
  });

  const fanOut = ["worker-a", "worker-b", "worker-c"].map((what) => ({
    what,
    args: { sessionId: routineKey("fanout"), what },
  }));

  const posted = await Promise.all(
    fanOut.map((w) =>
      inSession(() =>
        requestApproval(
          { org: "default", kind: "pr.open", args: w.args, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, postedTo: "slack/T1/C1", chain: { unattended: false } },
          { post: async () => ({ ok: true, ts: "999.000" }) as never },
        ),
      ),
    ),
  );

  ok(posted.every((p) => p.deduped !== true), "🔴 OPE-251: N workers proposing DISTINCT frozen args in ONE parent turn mint N cards — none dedups against another");
  ok(new Set(posted.map((p) => p.id)).size === fanOut.length, "🔴 OPE-251: and the N cards are N SEPARATE rows, each independently clickable");

  const twin = await inSession(() =>
    requestApproval(
      { org: "default", kind: "pr.open", args: fanOut[0]!.args, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, chain: { unattended: false } },
      { post: async () => ({ ok: true, ts: "999.000" }) as never },
    ),
  );
  ok(twin.deduped === true && twin.id === posted[0]!.id, "🔴 OPE-251 NEGATIVE CONTROL: an IDENTICAL re-proposal folds onto the live card — the dedup is on the frozen args, and it still works");

  const stranger = await inSession(() =>
    requestApproval(
      { org: "default", kind: "pr.open", args: { sessionId: routineKey("OTHER"), what: "not this session" }, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, chain: { unattended: false } },
      { post: async () => ({ ok: true, ts: "999.000" }) as never },
    ),
  );
  const tainted = await inSession(() =>
    requestApproval(
      { org: "default", kind: "pr.open", args: { sessionId: routineKey("fanout"), what: "read a hostile page first", tainted: true }, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, chain: { unattended: false } },
      { post: async () => ({ ok: true, ts: "999.000" }) as never },
    ),
  );

  const releaseNotices: string[] = [];
  const first = await resolveApprovalClick({
    org: "default",
    id: posted[0]!.id,
    decision: "approve_session",
    clickerId: "U_RANDOM_MEMBER",
    releaseFeedback: {
      post: async (_method: string, body: string) => {
        releaseNotices.push(body);
        return { ok: true } as Record<string, unknown>;
      },
    },
  });
  ok(first.outcome === "decided", "OPE-251: the clicked card is decided");
  ok(
    prExecuted.length === fanOut.length && new Set(prExecuted).size === fanOut.length,
    `🔴 OPE-251: ONE "approve for this routine" click executes EVERY worker of the concurrent fan-out — the grant reaches the workers already carded, not only the next one (saw: ${JSON.stringify(prExecuted)})`,
  );
  const rest = await Promise.all(posted.slice(1).map(async (p) => (await store.getPendingAction("default", p.id))?.status));
  ok(rest.every((s) => s === "approved"), "🔴 OPE-251: …and their cards are DECIDED, so nobody is left clicking a card for a session that was already granted");

  ok(
    releaseNotices.length === fanOut.length - 1,
    `🔴 OPE-251: every released row posts its own decision notice into its own conversation (saw ${String(releaseNotices.length)} for ${String(fanOut.length - 1)} released rows)`,
  );
  ok(
    releaseNotices.every((body) => body.includes("U_RANDOM_MEMBER")),
    "🔴 OPE-251: …attributed to the member who actually clicked, so the room can see one person's grant decided several cards",
  );

  ok(
    (await store.getPendingAction("default", stranger.id))?.status === "pending",
    "🔴 OPE-251 NEGATIVE CONTROL: a card of the SAME kind in a DIFFERENT session is UNTOUCHED — the release is keyed on the memo's own key",
  );
  ok(
    (await store.getPendingAction("default", tainted.id))?.status === "pending",
    "🔴 OPE-251 NEGATIVE CONTROL: a TAINTED proposal in the GRANTED session keeps its own human card — the same defence the propose-time memo bypass makes",
  );

  ok(
    (await store.getSessionApproval("default", routineKey("fanout"), "pr.open", new Date().toISOString()))?.grantedBy === "U_RANDOM_MEMBER",
    "OPE-251: the session memo is written too, so the NEXT worker skips its card as it always did",
  );

  const releaseRows = (await readAudit({ org: "default", action: SESSION_GRANT_RELEASED_ACTION })).filter((e) => e.detail?.id === posted[0]!.id);
  ok(releaseRows.length === 1, "OPE-251: the release writes ONE audit row joining the click to the cards it decided");
  ok(
    Array.isArray(releaseRows[0]?.detail?.released) && (releaseRows[0]!.detail!.released as string[]).length === fanOut.length - 1,
    "OPE-251: …naming every card it released, and only those",
  );

  const reachSession = routineKey("reach");
  const sameRoom = await inSession(() =>
    requestApproval(
      { org: "default", kind: "pr.open", args: { sessionId: reachSession, what: "the clicked one" }, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, chain: { unattended: false } },
      { post: async () => ({ ok: true, ts: "999.000" }) as never },
    ),
  );
  const otherRoom = await inSession(() =>
    requestApproval(
      { org: "default", kind: "pr.open", args: { sessionId: reachSession, what: "in another room" }, scopeKey: "slack/T1/C_ELSEWHERE", domain: null, requestedBy: "U_REQUESTER", channelId: "C_ELSEWHERE", threadTs: null, chain: { unattended: false } },
      { post: async () => ({ ok: true, ts: "999.000" }) as never },
    ),
  );
  const beforeReach = prExecuted.length;
  await resolveApprovalClick({
    org: "default",
    id: sameRoom.id,
    decision: "approve_session",
    clickerId: "U_RANDOM_MEMBER",
    clickContext: { surfaceKey: "slack/T1/C1" },
  });
  ok(prExecuted.length === beforeReach + 1, "OPE-251 PREMISE: the clicked card itself executes under a real click payload — so the assertion below is not vacuous");
  ok(
    (await store.getPendingAction("default", otherRoom.id))?.status === "pending",
    "🔴 OPE-251: a sibling card of the SAME granted session in ANOTHER ROOM is NOT released — the release is decided under the human's own click payload, so `clickRoomMatches` refuses it exactly as a direct click there would be",
  );

  memberExecuted = [];
  const members = await Promise.all(
    ["m-a", "m-b"].map((what) =>
      inSession(() =>
        requestApproval(
          { org: "default", kind: "test.member", args: { sessionId: routineKey("nongrant"), what }, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, chain: { unattended: false } },
          { post: async () => ({ ok: true, ts: "999.000" }) as never },
        ),
      ),
    ),
  );
  await resolveApprovalClick({ org: "default", id: members[0]!.id, decision: "approve_session", clickerId: "U_RANDOM_MEMBER" });
  ok(memberExecuted.length === 1, "🔴 OPE-251: approving a NON-GRANTABLE kind for the session executes exactly the clicked card…");
  ok(
    (await store.getPendingAction("default", members[1]!.id))?.status === "pending",
    "🔴 OPE-251: …and its sibling is STILL PENDING — no grant was written, so there is nothing to release",
  );
  ok(
    (await store.getSessionApproval("default", routineKey("nongrant"), "test.member", new Date().toISOString())) === null,
    "🔴 OPE-251: `approve_session` on a non-grantable kind writes NO memo — the release fires exactly where a memo does",
  );

  const inThread = threadKey("no-grant");
  const proposeInThread = (what: string) =>
    inSession(() =>
      requestApproval(
        { org: "default", kind: "pr.open", args: { sessionId: inThread, what }, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, chain: { unattended: false } },
        { post: async () => ({ ok: true, ts: "999.000" }) as never },
      ),
    );
  const firstInThread = await proposeInThread("same act");
  const siblingInThread = await proposeInThread("a sibling in the same thread");
  const beforeThread = prExecuted.length;
  await resolveApprovalClick({ org: "default", id: firstInThread.id, decision: "approve_session", clickerId: "U_RANDOM_MEMBER", clickContext: { surfaceKey: "slack/T1/C1" } });
  ok(prExecuted.length === beforeThread + 1, "OPE-2363 PREMISE: the clicked thread card itself executes");
  ok((await store.getSessionApproval("default", inThread, "pr.open", new Date().toISOString())) === null, "🔴 OPE-2363: the click in a thread writes NO grant");
  ok((await store.getPendingAction("default", siblingInThread.id))?.status === "pending", "🔴 OPE-2363: …so its sibling card in the same thread is NOT released");
  const secondInThread = await proposeInThread("same act");
  ok(secondInThread.id !== firstInThread.id, "🔴 OPE-2363: a SECOND IDENTICAL proposal in the same thread mints a card of its own");
  ok((await store.getPendingAction("default", secondInThread.id))?.status === "pending", "…and that card is pending: it waits for a person, not for a grant");
}

{
  const store = getOperationalStore();

  const GATE_DEADLINE_MS = 5_000;
  let openGate: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const shutGate = (): void => {
    gate = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, GATE_DEADLINE_MS);
      openGate = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  };
  shutGate();

  let entered: string[] = [];
  let completed: string[] = [];

  registerActionKind({
    kind: "pr.open",
    policy: "member",
    summarize: () => ["open a pull request"],
    async execute(args: unknown) {
      const what = String((args as { what?: unknown }).what);
      entered.push(what);
      if (what === "boom") throw new Error("the clicked act failed");
      if (what !== "clicked") await gate;
      completed.push(what);
      return "published";
    },
  });

  const propose = (sessionId: string, what: string): Promise<{ id: string }> =>
    inSession(() =>
      requestApproval(
        { org: "default", kind: "pr.open", args: { sessionId: routineKey(sessionId), what }, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQUESTER", channelId: "C1", threadTs: null, postedTo: "slack/T1/C1", chain: { unattended: false } },
        { post: async () => ({ ok: true, ts: "999.000" }) as never },
      ),
    );
  const releaseFeedback = { post: async () => ({ ok: true }) as Record<string, unknown> };

  const fan = ["clicked", "sib-1", "sib-2", "sib-3", "sib-4", "sib-5"];
  const posted: { id: string }[] = [];
  for (const what of fan) posted.push(await propose("sess-1709-ack", what));

  const deferred: Promise<unknown>[] = [];
  const startedAt = Date.now();
  const acked = await resolveApprovalClick({
    org: "default",
    id: posted[0]!.id,
    decision: "approve_session",
    clickerId: "U_RANDOM_MEMBER",
    releaseFeedback,
    waitUntil: (p: Promise<unknown>) => {
      deferred.push(p);
    },
  });
  const ackMs = Date.now() - startedAt;

  ok(acked.outcome === "decided", "OPE-1709 PREMISE: the clicked card is decided — so the assertions below are not vacuous");
  ok(
    entered.includes("clicked") && completed.includes("clicked"),
    "🔴 OPE-1709: the human's OWN act runs ON the ack path — moving the release off it must not move the clicked act off it too",
  );
  ok(
    entered[0] === "clicked",
    `🔴 OPE-1709: …and it runs FIRST, before the release loop starts — the clicked row's CAS→execute window no longer spans N sibling approve-and-execute cycles (saw: ${JSON.stringify(entered)})`,
  );
  ok(
    completed.length === 1,
    `🔴 OPE-1709: the ack path returns BEFORE any sibling has executed — the release is off the response path, not inside the interactivity budget (saw completed: ${JSON.stringify(completed)})`,
  );
  ok(deferred.length === 1, "🔴 OPE-1709: …because the release was handed to the ROUTE'S `waitUntil`, which is the only thing that keeps it alive past the response");
  ok(ackMs < 3_000, `🔴 OPE-1709: the click acks inside a chat vendor's three-second budget while five siblings are provably still unfinished (saw ${String(ackMs)} ms)`);

  openGate();
  await Promise.all(deferred);
  ok(
    completed.length === fan.length && new Set(completed).size === fan.length,
    `🔴 OPE-1709: every sibling still executes — off the response path, not instead of it (saw: ${JSON.stringify(completed)})`,
  );
  const siblingStatuses = await Promise.all(posted.slice(1).map(async (p) => (await store.getPendingAction("default", p.id))?.status));
  ok(siblingStatuses.every((s) => s === "approved"), "🔴 OPE-1709: …and all five sibling cards end DECIDED, exactly as OPE-251 requires");

  entered = [];
  completed = [];
  openGate();
  const inlineFan = ["clicked", "sib-x", "sib-y"];
  const inlinePosted: { id: string }[] = [];
  for (const what of inlineFan) inlinePosted.push(await propose("sess-1709-inline", what));
  await resolveApprovalClick({ org: "default", id: inlinePosted[0]!.id, decision: "approve_session", clickerId: "U_RANDOM_MEMBER", releaseFeedback });
  ok(
    completed.length === inlineFan.length,
    `🔴 OPE-1709 NEGATIVE CONTROL: with NO \`waitUntil\` the release is AWAITED — every sibling has executed by the time the call returns, the pre-OPE-1709 shape (saw: ${JSON.stringify(completed)})`,
  );

  entered = [];
  completed = [];
  const capped: { id: string }[] = [];
  capped.push(await propose("sess-1709-cap", "clicked"));
  for (let i = 0; i < MAX_SESSION_GRANT_RELEASES + 1; i++) capped.push(await propose("sess-1709-cap", `cap-${String(i)}`));
  await resolveApprovalClick({ org: "default", id: capped[0]!.id, decision: "approve_session", clickerId: "U_RANDOM_MEMBER", releaseFeedback });

  const capStatuses = await Promise.all(capped.slice(1).map(async (p) => (await store.getPendingAction("default", p.id))?.status));
  ok(
    capStatuses.filter((s) => s === "approved").length === MAX_SESSION_GRANT_RELEASES,
    `🔴 OPE-1709: ONE click releases at most MAX_SESSION_GRANT_RELEASES (${String(MAX_SESSION_GRANT_RELEASES)}) sibling cards (saw ${String(capStatuses.filter((s) => s === "approved").length)})`,
  );
  ok(
    capStatuses.filter((s) => s === "pending").length === 1,
    `🔴 OPE-1709: …and the card past the cap is left PENDING and clickable, never silently decided (saw ${String(capStatuses.filter((s) => s === "pending").length)} pending)`,
  );
  ok(
    completed.length === MAX_SESSION_GRANT_RELEASES + 1,
    `🔴 OPE-1709: …and exactly the released rows plus the clicked one ran an execute — the cap bounds WORK, not just the row statuses (saw ${String(completed.length)})`,
  );

  const capRow = (await readAudit({ org: "default", action: SESSION_GRANT_RELEASED_ACTION })).find((e) => e.detail?.id === capped[0]!.id);
  ok(
    capRow?.detail?.candidates === MAX_SESSION_GRANT_RELEASES + 1 && capRow?.detail?.cap === MAX_SESSION_GRANT_RELEASES,
    `🔴 OPE-1709: the release's audit row records that the candidate set was CUT — how many were eligible and what the cap was (saw: ${JSON.stringify(capRow?.detail ?? null)})`,
  );
  const uncutRow = (await readAudit({ org: "default", action: SESSION_GRANT_RELEASED_ACTION })).find((e) => e.detail?.id === posted[0]!.id);
  ok(
    uncutRow !== undefined && uncutRow.detail?.candidates === undefined && uncutRow.detail?.cap === undefined,
    "🔴 OPE-1709 NEGATIVE CONTROL: a release that hit no cap carries NO truncation fields — the row says a set was cut only when one was",
  );

  entered = [];
  completed = [];
  const boomClicked = await propose("sess-1709-boom", "boom");
  const boomSibling = await propose("sess-1709-boom", "boom-sib");
  const boomRes = await resolveApprovalClick({ org: "default", id: boomClicked.id, decision: "approve_session", clickerId: "U_RANDOM_MEMBER", releaseFeedback });
  ok(boomRes.outcome === "decided" && boomRes.executed === "failed", "OPE-1709 PREMISE: the clicked act really threw, and the resolution says so");
  ok(
    entered[0] === "boom",
    `🔴 OPE-1709: …and it was still ENTERED FIRST — the ordering holds on the failure path too, not only the happy one (saw: ${JSON.stringify(entered)})`,
  );
  ok(
    completed.includes("boom-sib") && (await store.getPendingAction("default", boomSibling.id))?.status === "approved",
    "🔴 OPE-1709: a clicked act that FAILS still releases the cards the grant covers — the release runs in a `finally`, because the grant is a decision about the SESSION, not about this one call",
  );

  shutGate();
  entered = [];
  completed = [];
  const quietClicked = await propose("sess-1709-quiet", "clicked");
  const quietSibling = await propose("sess-1709-quiet", "sib-quiet");
  const quietDeferred: Promise<unknown>[] = [];
  await resolveApprovalClick({
    org: "default",
    id: quietClicked.id,
    decision: "approve_session",
    clickerId: "U_RANDOM_MEMBER",
    releaseFeedback: {
      post: async () => {
        throw new Error("chat.postMessage refused");
      },
    },
    waitUntil: (p: Promise<unknown>) => {
      quietDeferred.push(p);
    },
  });
  openGate();
  let rejected = false;
  await Promise.all(quietDeferred).catch(() => {
    rejected = true;
  });
  ok(!rejected, "🔴 OPE-1709: a notice poster that REFUSES does not reject the promise the route is handed — the release tail swallows its own failures, so the host sees a settled promise");
  ok(
    (await store.getPendingAction("default", quietSibling.id))?.status === "approved" && completed.includes("sib-quiet"),
    "🔴 OPE-1709 …AND THE DECISION STILL LANDS: a failed notice costs the room its message, never the release — the same fail-soft posture the sweep's own feedback takes",
  );

  openGate();
  entered = [];
  completed = [];
  const refusedClicked = await propose("sess-1709-refused", "clicked");
  const refusedSibling = await propose("sess-1709-refused", "sib-refused");
  let refusals = 0;
  let threw = false;
  const refusedRes = await resolveApprovalClick({
    org: "default",
    id: refusedClicked.id,
    decision: "approve_session",
    clickerId: "U_RANDOM_MEMBER",
    releaseFeedback,
    waitUntil: () => {
      refusals += 1;
      throw new Error("invocation already closing");
    },
  }).catch(() => {
    threw = true;
    return undefined;
  });
  ok(refusals === 1, `OPE-1709 PREMISE: the route's hook really was called and really refused — so this arm drives the fallback and is not vacuous (saw ${String(refusals)} call(s))`);
  ok(
    threw === false && refusedRes?.outcome === "decided",
    "🔴 OPE-1709: a `waitUntil` that THROWS never reaches the caller — the click still resolves, because a refused registration is the host's problem, not the clicker's",
  );
  ok(
    (await store.getPendingAction("default", refusedSibling.id))?.status === "approved" && completed.includes("sib-refused"),
    `🔴 OPE-1709: …and the release is AWAITED rather than dropped — the sibling is already decided and executed by the time the call returns, the no-hook shape (saw completed: ${JSON.stringify(completed)})`,
  );
}

console.log(`\n✓ approvals: ${n} assertions passed (card render, OPE-307 taint disclosure, store CAS, registry, execute parity, click matrix, card-signal, TTL sweep, cross-thread decision wake, sweep expiry feedback, OPE-185 clicker gate, OPE-220 card audience gate, OPE-332 decision venue, OPE-574 HITL-answer admission, OPE-1604 halt-at-the-click, OPE-251 one click reaches the concurrent fan-out, OPE-1709 the release is off the ack path and capped)\n`);
