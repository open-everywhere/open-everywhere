import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { PendingActionRow } from "../agent/approvals/types.js";

const dir = join(tmpdir(), `open-everywhere-card-summary-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] });

const { parseApprovalAction, OE_APPROVAL_PREFIX } = await import("../agent/approvals/flow.js");
await import("../agent/approvals/session-checkpoint.js");
const { registeredActionKinds, actionKind } = await import("../agent/approvals/actions.js");
const { plainSummaryForRow, plainSummaryForArgs } = await import("../agent/approvals/plain-summary.js");
const { plainValue, finishPlainSentence, PLAIN_SUMMARY_MAX } = await import("../agent/approvals/plain-text.js");
const { pendingCardLayout, pendingCardOptions } = await import("../agent/approvals/card-layout.js");
const { pendingCardBlocks, decidedCardBlocks, groupedCardBlocks, groupedHeadline, GROUPED_CARD_MAX_ITEMS } = await import("../agent/approvals/card.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function row(over: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: "p-1",
    org: "default",
    kind: "spend.set",
    argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyUsd: 50, currentCap: null, scopeLabel: "#general" }),
    scopeKey: "slack/T1/C1",
    domain: null,
    requestedBy: "U_REQUESTER",
    channelId: "C1",
    threadTs: null,
    messageTs: "111.222",
    postedTo: "slack/T1/C1",
    status: "pending",
    createdAt: "2026-10-11T00:00:00Z",
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

const MARKUP = /[<>[\]*`|]/u;

{
  const kinds = registeredActionKinds();
  ok(kinds.length >= 25, `the registry is populated (got ${kinds.length} kinds) — an empty registry would pass the loop below vacuously`);
  for (const kind of kinds) ok(typeof actionKind(kind)?.plainSummary === "function", `kind "${kind}" defines plainSummary`);
}

{
  const cases: { kind: string; args: unknown; expect: readonly string[] }[] = [
    { kind: "spend.set", args: { scopeKey: "slack/T1/C1", scopeLabel: "#general", level: "surface", monthlyUsd: 50 }, expect: ["spend limit", "#general", "$50.00/mo"] },
    { kind: "spend.clear", args: { scopeKey: "slack/T1/C1", scopeLabel: "#general", level: "surface", currentCap: null }, expect: ["back on its configured spend limit", "#general"] },
    { kind: "chat.dm", args: { platform: "slack", principalId: "U0123ABC", text: "hi", footer: "f", grant: "g" }, expect: ["direct message", "<@U0123ABC>"] },
    { kind: "chat.post", args: { platform: "slack", container: "C0999", text: "hi", grant: "g" }, expect: ["Post a message", "<#C0999>"] },
    { kind: "ticket.assign", args: { platform: "linear", entityId: "ENG-12", assignee: "ana" }, expect: ["Assign", "ENG-12", "ana"] },
    { kind: "ticket.set_state", args: { platform: "linear", entityId: "ENG-12", state: "Done" }, expect: ["ENG-12", "Done"] },
    { kind: "ticket.create", args: { platform: "github", target: "acme/web", title: "Fix login", body: "" }, expect: ["GitHub issue", "acme/web", "Fix login"] },
    { kind: "pr.open", args: { repo: "acme/web", title: "Bump deps", head: "h", base: "main", headSha: "abc", body: "" }, expect: ["pull request", "acme/web", "Bump deps"] },
    { kind: "routine.cancel", args: { id: "r1", description: "daily digest" }, expect: ["Stop the routine", "daily digest"] },
    { kind: "memory.purge", args: { bullets: [{ sha256: "x", chars: 3 }, { sha256: "y", chars: 4 }], locations: [] }, expect: ["delete 2 remembered facts"] },
    { kind: "skill.delete", args: { name: "triage", domain: "eng" }, expect: ["Delete the skill", "triage", "eng"] },
    { kind: "webhook.rotate", args: { hookId: "stripe", requestedBy: "U1", surfaceKey: "slack/T1/C1" }, expect: ["signing secret", "stripe", "stops working"] },
    { kind: "connector.revoke", args: { connector: "notion", scopeKey: "slack/T1/C1" }, expect: ["Turn off", "notion"] },
    { kind: "halt.resume", args: { orgWide: true }, expect: ["Lift the emergency halt", "everywhere"] },
    { kind: "a2a.delegate", args: { org: "default", scopeKey: "slack/T1/C1", agent: "travel-bot", host: "agents.example.com", message: "book", sessionKey: "k", memoKind: "m", requestedBy: "U1" }, expect: ["outside agent", "travel-bot", "agents.example.com", "U1"] },
    { kind: "mcp-server.propose", args: { configRepo: "acme/oe-config", declaration: { name: "fullstory" } }, expect: ["pull request", "acme/oe-config", "MCP server fullstory", "admin"] },
  ];
  for (const c of cases) {
    const s = plainSummaryForArgs(c.kind, c.args);
    ok(!s.startsWith("The agent asks to run"), `${c.kind}: the kind's own sentence renders, not the fallback (got "${s}")`);
    for (const word of c.expect) ok(s.includes(word), `${c.kind}: the sentence names "${word}" (got "${s}")`);
    ok(s.length <= PLAIN_SUMMARY_MAX, `${c.kind}: the sentence fits ${PLAIN_SUMMARY_MAX} characters`);
    ok(/[.!?…]$/u.test(s), `${c.kind}: the sentence ends with an end mark`);
    ok(!s.includes("\n"), `${c.kind}: the sentence is one line`);
  }
}

{
  const hostile = "<https://evil.example|click here> *urgent* `x` [ok](https://evil.example)\nsecond line";
  const cleaned = plainValue(hostile, 200);
  ok(!MARKUP.test(cleaned), `plainValue strips every markup character (got "${cleaned}")`);
  ok(!cleaned.includes("\n"), "plainValue collapses newlines");
  const s = plainSummaryForArgs("chat.post", { platform: "slack", container: hostile, text: "t", grant: "g" });
  ok(!MARKUP.test(s), `a hostile container name reaches the sentence without markup (got "${s}")`);
  ok(plainValue("x".repeat(500)).length <= 60, "plainValue caps one value");
  const broadcast = plainValue("@everyone fix now @here @Here", 200);
  ok(!/@(everyone|here)\b/iu.test(broadcast), `plainValue drops the @ of a bare broadcast mention (got "${broadcast}")`);
  const cutValue = plainValue(`${"x".repeat(53)} @heresy`);
  ok(!/@(everyone|here)\b/iu.test(cutValue), `🔴 a cut value cannot end in a broadcast mention (got "${cutValue}")`);
  const cutSentence = finishPlainSentence(`${"w".repeat(139)} @everyoneZZZ`);
  ok(!/@(everyone|here)\b/iu.test(cutSentence), `🔴 a cut sentence cannot end in a broadcast mention (got "${cutSentence}")`);
  for (const doubled of ["@@everyone", "@@@here now"]) {
    const out = plainValue(doubled, 200);
    ok(!/@(everyone|here)\b/iu.test(out), `🔴 a doubled @ cannot leave a broadcast mention behind ("${doubled}" became "${out}")`);
  }
  ok(plainValue("ana@example.com") === "ana@example.com", "plainValue keeps an ordinary @ (an email address)");
  const bare = plainValue("see https://evil.example now", 200);
  ok(bare.includes("https://evil.example"), "a bare URL survives as visible text — the docs say so, and this pins it");
  ok(plainValue(undefined) === "(unnamed)" && plainValue("   ") === "(unnamed)", "a missing value reads (unnamed), never an empty gap");
}

{
  const unknown = plainSummaryForRow({ kind: "no.such.kind", argsJson: "{}" });
  ok(unknown.startsWith("The agent asks for an action this card cannot describe") && !unknown.includes("no.such.kind"), `an unregistered kind gets the generic sentence, which names no kind (got "${unknown}")`);
  const broken = plainSummaryForRow({ kind: "chat.post", argsJson: "{not json" });
  ok(broken === unknown, "unparseable args get the generic sentence, never a throw");
}

{
  const r = row();
  const headline = plainSummaryForRow(r);
  const card = pendingCardBlocks(r, ["Set spend limit — #general (surface)", "$: none → $50.00/mo"]);
  const first = card.blocks[0] as { type: string; block_id: string; text: { type: string; text: string } };
  ok(first.type === "section" && first.text.type === "mrkdwn" && first.text.text === `*${headline}*`, "🔴 the pending card's FIRST block is the plain sentence, in bold");
  ok(first.block_id === `oe_approval_card:spend.set:${r.id}`, "the first block's id carries the kind, where no person reads it");
  ok(!JSON.stringify(card.blocks.map((b) => (b as { text?: unknown; elements?: unknown }).text ?? (b as { elements?: unknown }).elements)).includes("spend.set"), "🔴 no visible block carries the kind label");
  ok(!JSON.stringify(card.blocks).includes("Set spend limit — #general (surface)"), "🔴 the detail lines are not visible");
  ok((card.metadata?.event_payload as { detail?: string[] }).detail?.[0] === "Set spend limit — #general (surface)", "the detail rides the message metadata");
  ok(card.text.split("\n")[0] === headline, "the notification fallback text leads with the sentence");
  ok(!card.text.includes("Approval requested") && !card.text.includes("spend.set"), "the fallback text carries no kind label");
  const decided = decidedCardBlocks({ ...r, status: "approved", decidedBy: "U_ADMIN" }, ["line"], "spend limit set");
  ok(decided.blocks.length === 1 && decided.text === "✅ Approved by <@U_ADMIN> — spend limit set", `the decided card is ONE line (got ${JSON.stringify(decided.text)})`);
  ok(!decided.blocks.some((b) => b.type === "actions"), "the decided card has no buttons");
}

{
  const conv = pendingCardOptions(row());
  ok(conv.map((o) => o.verb).join(",") === "approve,reject", "a conversation card offers Approve and Reject only (OPE-2363)");
  const routine = pendingCardOptions(row({ kind: "pr.open", argsJson: JSON.stringify({ sessionId: "oe-routine:r1:g1" }) }));
  ok(routine.map((o) => o.verb).join(",") === "approve,approve_session,reject", "a routine's card puts its grant option BETWEEN Approve and Reject");
  ok(routine[0].tone === "primary" && routine[routine.length - 1].tone === "danger", "Approve leads and Reject closes: any later option slots between them");
  for (const o of routine) ok(parseApprovalAction(`${OE_APPROVAL_PREFIX}${o.verb}:p-1`)?.decision === o.verb, `option verb "${o.verb}" is one the click core parses`);
  const r = row({ kind: "pr.open", argsJson: JSON.stringify({ sessionId: "oe-routine:r1:g1" }) });
  const actions = pendingCardBlocks(r, ["x"]).blocks.find((b) => b.type === "actions") as unknown as { elements: { action_id: string; text: { text: string } }[] };
  ok(actions.elements.map((e) => e.action_id).join(",") === pendingCardLayout(r, ["x"]).options.map((o) => `${OE_APPROVAL_PREFIX}${o.verb}:${r.id}`).join(","), "the Slack buttons are the layout's options, in the layout's order");
  ok(!pendingCardOptions(row()).some((o) => (o.verb as string) === "approve_allow"), "OPE-2456's approve-and-allow option is NOT built: plain Approve stays one-off");
}

{
  const a = row({ id: "g-a", kind: "chat.post", argsJson: JSON.stringify({ platform: "slack", container: "C1", text: "a", grant: "g" }) });
  const b = row({ id: "g-b", kind: "ticket.assign", argsJson: JSON.stringify({ platform: "linear", entityId: "ENG-1", assignee: "ana" }) });
  const c = row({ id: "g-c", kind: "skill.delete", argsJson: JSON.stringify({ name: "triage", domain: "eng" }), status: "approved", decidedBy: "U_ADMIN" });
  const card = groupedCardBlocks([
    { row: a, summaryLines: ["post"] },
    { row: b, summaryLines: ["assign"] },
    { row: c, summaryLines: ["delete"] },
  ]);
  const header = card.blocks[0] as { type: string; text: { text: string } };
  ok(header.type === "header" && header.text.text === groupedHeadline(3, 2), `the grouped card opens with a plain count of what is still open (got "${header.text.text}")`);
  const actionIds = card.blocks.filter((blk) => blk.type === "actions").flatMap((blk) => (blk as unknown as { elements: { action_id: string }[] }).elements.map((e) => e.action_id));
  ok(actionIds.includes(`${OE_APPROVAL_PREFIX}approve:g-a`) && actionIds.includes(`${OE_APPROVAL_PREFIX}reject:g-b`), "each OPEN item keeps its own row-scoped buttons");
  ok(!actionIds.some((id) => id.endsWith(":g-c")), "a DECIDED item has no buttons");
  const json = JSON.stringify(card.blocks);
  ok(json.includes(`1. ${plainSummaryForRow(a)}`) && json.includes(`2. ${plainSummaryForRow(b)}`), "each item opens with its own numbered plain sentence");
  ok(json.includes("3. ✅ Approved by <@U_ADMIN>"), "a decided item is its one decided line");
  ok(!card.text.includes("Approval requested"), "the grouped fallback carries no label (OPE-2481)");
  ok((card.metadata?.event_payload as { items?: { kind: string }[] }).items?.map((i) => i.kind).join(",") === "chat.post,ticket.assign,skill.delete", "the grouped metadata carries each item's kind");
  const full = groupedCardBlocks(Array.from({ length: GROUPED_CARD_MAX_ITEMS }, (_, i) => ({ row: row({ id: `g-${i}` }), summaryLines: ["x"] })));
  ok(full.blocks.length <= 50, `a full grouped card (${GROUPED_CARD_MAX_ITEMS} items) fits Slack's 50-block message limit (got ${full.blocks.length})`);
}

console.log(`approval-card-summary-test: ${n} assertions passed`);
