import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "open-everywhere-allow-rule-")), "ops.sqlite3");

const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
const { registerConfig } = await import("../agent/access/config.js");
const { registerActionKind } = await import("../agent/approvals/actions.js");
const { requestApproval, resolveApprovalClick, parseApprovalAction } = await import("../agent/approvals/flow.js");
const { pendingCardOptions, optionsWithoutConfirm } = await import("../agent/approvals/card-layout.js");
const { pendingCardBlocks } = await import("../agent/approvals/card.js");
const { allowRuleProposalForRow, allowRuleText, widenAllowRuleSubject, ALLOW_RULE_CONFIRM_TEXT_MAX, ALLOW_RULE_LABEL } = await import("../agent/approvals/allow-rule.js");
const { planAllowRuleClick, dmRulesForProposal } = await import("../agent/approvals/allow-rule-apply.js");
const { executeDomainRulePr } = await import("../agent/approvals/allow-rule-pr.js");
const { ruleInstanceProblems, preApprovalRuleProblems, renderPreApprovalRulesBlock } = await import("../agent/access/pre-approval-rules.js");
const { defineDomainRules, domainRuleBindings, domainRuleBundles, upsertDomainRuleEntry } = await import("../agent/access/domain-rules.js");
const { registerApprovalJudgeCompletion, resetApprovalJudgeCompletion, clearApprovalJudgeVerdictCache } = await import("../agent/access/approval-judge.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { buildHomeView, runHomeAction } = await import("../agent/home/home-view.js");
const { RULES_HOME_ACTIONS, ruleHomeRef } = await import("../agent/home/rules-home.js");
import type { PendingActionRow } from "../agent/approvals/types.js";
import type { HomeViewer } from "../agent/home/home-view.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const ORG = "allow-org";
const DM = "slack/T1/D_ANA";
const ROOM = "slack/T1/C_ENG";

let accessRequests: Record<string, unknown> | null = null;
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "eng", reach: [ROOM] }] as never,
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadAccessRequests: () => accessRequests as never,
});
overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });

const executed: string[] = [];
for (const kind of ["access.request", "pr.open"]) {
  registerActionKind({
    kind,
    policy: "member",
    summarize: (a: { what: string }) => [`${kind}: ${a.what}`],
    plainSummary: (a: { what: string }) => `Do ${a.what}`,
    async execute(a: { what: string }) {
      executed.push(a.what);
      return `did ${a.what}`;
    },
  });
}

let seq = 0;
function row(over: Partial<PendingActionRow> & { args?: Record<string, unknown> } = {}): PendingActionRow {
  const { args, ...rest } = over;
  seq++;
  return {
    id: `row-${seq}`,
    org: ORG,
    kind: "pr.open",
    argsJson: JSON.stringify(args ?? { what: `thing ${seq}`, tainted: false }),
    scopeKey: DM,
    domain: null,
    requestedBy: "U_ANA",
    channelId: "D_ANA",
    threadTs: null,
    messageTs: null,
    postedTo: DM,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    ...rest,
  };
}

async function stored(r: PendingActionRow): Promise<PendingActionRow> {
  await getOperationalStore().addPendingAction(r);
  return r;
}

{
  ok(ruleInstanceProblems("Delete Notion page 7 when asked.").length > 0, "lint: a numbered object is refused");
  ok(ruleInstanceProblems("Close issue #42.").length > 0, "lint: a #number is refused");
  ok(ruleInstanceProblems("Edit https://notion.so/abc.").length > 0, "lint: a URL is refused");
  ok(ruleInstanceProblems("Move OPE-12 to done.").length > 0, "lint: a tracker key is refused");
  ok(ruleInstanceProblems("Post in C0123ABCD9.").length > 0, "lint: a platform id is refused");
  ok(ruleInstanceProblems("Delete Notion pages this domain's agent created, at most once an hour.").length === 0, "lint (negative control): a policy sentence passes");
  const bad = preApprovalRuleProblems("domain-rules:eng", [{ id: "one-page", rule: "Delete Notion page 7 when asked." }], new Set());
  ok(bad.some((l) => l.includes("names one object")), "lint: config load refuses an instance rule in the domain rules file");
  ok(preApprovalRuleProblems("domain-rules:eng", [{ id: "policy", rule: "Delete Notion pages when asked." }], new Set()).length === 0, "lint (negative control): a policy rule loads");
  ok(preApprovalRuleProblems("org-policy", [{ id: "limit", rule: "A routine that reads more than 10000 rows of UTF-8 text is routine." }], new Set()).length === 0, "lint: an admin bundle's policy limit and standard name still load");
  ok(ruleInstanceProblems("more than 10000 rows").length > 0, "lint: the lint is not exact (why it skips admin bundles)");
  assert.throws(() => defineDomainRules([{ domain: "eng", id: "eng.x", rule: "Close issue #42 when asked." }]), /names one object/u);
  n++;
}

{
  const dm = allowRuleProposalForRow(row());
  ok(dm?.venue === "dm" && dm.id === "dm.open-pull-request.open", "proposal: a judge-deferred act in the person's own DM proposes a DM rule");
  ok(dm !== undefined && dm.rule.startsWith("In this DM, open pull requests with open_pull_request when the person asked for it in this turn"), "proposal: code writes the rule from the tool, the action and the object");
  ok(dm !== undefined && ruleInstanceProblems(dm.rule).length === 0, "proposal: the rule passes the instance lint");
  ok(!allowRuleProposalForRow(row({ args: { what: "Notion page 7 for https://x.example/a", tainted: false } }))!.rule.includes("page 7"), "proposal: no argument text reaches the rule");
  ok(allowRuleProposalForRow(row({ args: { what: "x", tainted: true } })) === undefined, "proposal: a tainted proposal gets no option");
  ok(allowRuleProposalForRow(row({ args: { what: "x" } })) === undefined, "proposal: a tool card that does not freeze `tainted: false` reads as tainted (fail-closed)");
  ok(allowRuleProposalForRow(row({ kind: "access.request", args: { org: ORG, requestId: "r", requestedBy: "U_ANA" } })) === undefined, "proposal: an access.request card, which freezes no taint flag today, gets no option");
  ok(allowRuleProposalForRow(row({ kind: "spend.set" })) === undefined, "proposal: an admin act gets no option (human-only)");
  ok(allowRuleProposalForRow(row({ kind: "memory.purge" })) === undefined, "proposal: a memory erasure gets no option (human-only)");
  ok(allowRuleProposalForRow(row({ kind: "routine.create", args: { permissions: ["pr.open"], tainted: false } })) === undefined, "proposal: a routine with a standing write gets no option");
  ok(allowRuleProposalForRow(row({ kind: "routine.create", args: { permissions: [], tainted: false } }))?.id === "dm.create-routine.create", "proposal (negative control): a routine with no standing write gets one");
  ok(allowRuleProposalForRow(row({ scopeKey: "teams/T1/D_X" })) === undefined, "proposal: a non-Slack room gets no option (no confirmation dialog)");
  ok(allowRuleProposalForRow(row({ scopeKey: "slack/T1/G_GROUP" })) === undefined, "proposal: a room with no domain and no DM gets no option");
  ok(allowRuleProposalForRow(row({ scopeKey: ROOM, domain: "eng" })) === undefined, "proposal: a domain room with no config repo gets no option");
  accessRequests = { adminChannel: "C_ADMIN", configRepo: "acme/app-config", dryRun: false };
  const dom = allowRuleProposalForRow(row({ scopeKey: ROOM, domain: "eng" }));
  ok(dom?.venue === "domain" && dom.domain === "eng" && dom.id === "eng.open-pull-request.open" && dom.rule.startsWith("In this domain,"), "proposal: a domain room with a config repo proposes a domain rule");

  const op = { tool: "linear__create_issue", connection: "linear", grain: "per-call", opTier: "write", credential: "domain", inputPreview: "{}", sessionKey: "s", memoKind: "m", requestedBy: "U_ANA", org: ORG, scopeKey: ROOM };
  const conn = allowRuleProposalForRow(row({ kind: "op.connector", scopeKey: ROOM, domain: "eng", args: op }));
  ok(conn?.subject.tool === "linear" && conn.subject.objects[0] === "issues" && conn.subject.action === "create", "proposal: a connector write names the connector, the action and the object kind");
  const archive = allowRuleProposalForRow(row({ kind: "op.connector", scopeKey: ROOM, domain: "eng", args: { ...op, tool: "linear__archive_issue" } }));
  ok(archive !== undefined && archive.rule.includes("archive issues with the linear connector's archive_issue") && archive.id !== conn!.id, "proposal: a write-tier op names its own verb, and never widens another verb's rule");
  ok(allowRuleProposalForRow(row({ kind: "op.connector", scopeKey: ROOM, domain: "eng", args: { ...op, credential: "personal" } })) === undefined, "proposal: a connector op on a person's own account gets no option");
  const del = allowRuleProposalForRow(row({ kind: "op.connector", scopeKey: ROOM, domain: "eng", args: { ...op, tool: "notion__delete_page", connection: "notion", opTier: "destructive" } }));
  ok(del !== undefined && del.rule.includes("delete pages, one named item per call") && del.rule.includes("never in bulk"), "proposal: a delete rule keeps the one-item limit");
  const trash = allowRuleProposalForRow(row({ kind: "op.connector", scopeKey: ROOM, domain: "eng", args: { ...op, tool: "notion__trash_page", connection: "notion", opTier: "destructive" } }));
  ok(trash !== undefined && trash.rule.includes("trash pages") && !trash.rule.includes("delete"), "proposal: the action word is the op's own verb, not the tier's name");
  accessRequests = null;

  overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  ok(allowRuleProposalForRow(row()) === undefined, "proposal: with the judge off no rule could lift anything, so no option");
  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });

  const widened = widenAllowRuleSubject({ tool: "linear", action: "create", objects: ["issues"], ops: ["create_issue"] }, { tool: "linear", action: "create", objects: ["projects"], ops: ["create_project"] });
  ok(widened.objects.join(",") === "issues,projects" && widened.ops!.join(",") === "create_issue,create_project", "merge: a second object widens the subject");
  ok(allowRuleText("domain", widened).includes("issues and projects"), "merge: the widened rule names both kinds of object");
}

{
  const r = row();
  const options = pendingCardOptions(r);
  ok(options.map((o) => o.verb).join(",") === "approve,approve_rule,reject", "card: Approve, then the rule option, then Reject");
  const opt = options.find((o) => o.verb === "approve_rule")!;
  ok(opt.label === ALLOW_RULE_LABEL && opt.confirm !== undefined && opt.confirm.text.includes(allowRuleProposalForRow(r)!.rule), "card: the option carries the proposed rule as its confirmation");
  ok(opt.confirm!.text.length <= ALLOW_RULE_CONFIRM_TEXT_MAX, "card: the confirmation fits Slack's dialog");
  const blocks = JSON.stringify(pendingCardBlocks(r, ["x"]).blocks);
  ok(blocks.includes(`"action_id":"oe_approval:approve_rule:${r.id}"`) && blocks.includes('"confirm":{"title"'), "card: Slack renders the option with a confirmation dialog");
  ok(parseApprovalAction(`oe_approval:approve_rule:${r.id}`)?.decision === "approve_rule", "card: the click grammar parses the new verb");
  ok(optionsWithoutConfirm(options).every((o) => (o.verb as string) !== "approve_rule"), "card: a surface with no confirmation never renders the option");
  ok(pendingCardOptions(row({ kind: "spend.set" })).every((o) => o.verb !== "approve_rule"), "card (negative control): an admin act's card has no rule option");
}

const click = (r: PendingActionRow, decision: "approve" | "approve_rule", over: { clickerId?: string; clickerIsGuest?: boolean | undefined; surfaceKey?: string } = {}) =>
  resolveApprovalClick({
    org: ORG,
    id: r.id,
    decision,
    clickerId: over.clickerId ?? r.requestedBy,
    clickerPlatform: "slack",
    clickContext: { surfaceKey: over.surfaceKey ?? r.postedTo! },
    ...("clickerIsGuest" in over ? (over.clickerIsGuest === undefined ? {} : { clickerIsGuest: over.clickerIsGuest }) : { clickerIsGuest: false }),
  });
const dmRules = async () => getOperationalStore().listDmRules(ORG, DM);
let ruleSource: PendingActionRow | undefined;
{
  const plain = await stored(row());
  const res = await click(plain, "approve");
  ok(res.outcome === "decided" && (await dmRules()).length === 0, "dm: plain Approve approves the act and writes NO rule");

  const guest = await stored(row());
  const g = await click(guest, "approve_rule", { clickerIsGuest: undefined });
  ok(g.outcome === "decided" && g.executed === "ok" && (await dmRules()).length === 0, "dm: an unconfirmed clicker's act runs, and no rule is written");
  ok(g.outcome === "decided" && g.outcomeLine.includes("Guests and external accounts cannot add rules"), "dm: the outcome line says why no rule was written");

  const other = await stored(row());
  const o = await click(other, "approve_rule", { clickerId: "U_BOB" });
  ok(o.outcome === "decided" && (await dmRules()).length === 0 && o.outcomeLine.includes("only the person this DM belongs to"), "dm: another person's click writes no rule");

  const mine = await stored(row());
  ruleSource = mine;
  const m = await click(mine, "approve_rule");
  const rules = await dmRules();
  ok(m.outcome === "decided" && m.executed === "ok" && rules.length === 1, "dm: the owner's confirmed click approves the act AND writes the rule");
  ok(m.outcome === "decided" && m.outcomeLine.includes("rule added to your DM — it applies at once"), "dm: the outcome line names the rule");
  ok(rules[0]!.ownerId === "U_ANA" && rules[0]!.sourceActionId === mine.id && rules[0]!.ruleId === "dm.open-pull-request.open", "dm: the rule names its owner and its card");

  const again = await stored(row());
  const a = await click(again, "approve_rule");
  ok(a.outcome === "decided" && a.outcomeLine.includes("already have this rule") && (await dmRules()).length === 1, "dm: merge before add — the same rule is not added twice");

  const forged = await stored(row({ kind: "spend.set", args: { what: "x", tainted: false } }));
  registerActionKind({ kind: "spend.set", policy: "member", summarize: () => ["s"], plainSummary: () => "S", execute: async () => "set" });
  const f = await click(forged, "approve_rule");
  ok(f.outcome === "decided" && f.outcomeLine.includes("offers no rule") && (await dmRules()).length === 1, "dm: a forged rule click on a card with no option approves one act only");

  const audit = await readAudit({ org: ORG } as never);
  const refused = audit.filter((x) => x.action === "approval.rule.refused").map((x) => String(x.detail?.reason)).sort();
  ok(JSON.stringify(refused) === JSON.stringify(["already-covered", "guest-clicker", "no-rule-offered", "not-owner"]), `dm: each refusal leaves one approval.rule.refused row that names its reason (got ${refused.join(", ")})`);
  const added = audit.filter((x) => x.action === "approval.rule.added");
  ok(added.length === 1 && added[0]!.detail?.ruleId === "dm.open-pull-request.open" && added[0]!.detail?.change === "added", "dm: the confirmed rule leaves one approval.rule.added row naming the rule");
}

{
  ok((await dmRulesForProposal(ORG, DM, "U_ANA")).length === 1, "judge read: the owner's ask in their DM reads their rule");
  ok((await dmRulesForProposal(ORG, DM, "U_BOB")).length === 0, "judge read: another person's ask reads none");
  ok((await dmRulesForProposal(ORG, "slack/T1/D_OTHER", "U_ANA")).length === 0, "judge read: another room reads none");
  ok((await dmRulesForProposal(ORG, ROOM, "U_ANA")).length === 0, "judge read: a channel reads none");
  ok(renderPreApprovalRulesBlock(await dmRulesForProposal(ORG, DM, "U_ANA")).includes("confirmed by the requester in their own DM"), "judge read: the prompt says a DM rule is the person's own, not admin-authored");

  const prompts: string[] = [];
  registerApprovalJudgeCompletion(async (prompt, pass) => {
    prompts.push(prompt);
    return pass === "scrutiny" ? "YES" : "VERDICT: allow\nREASON: the person asked\nRULE: dm.open-pull-request.open";
  });
  clearApprovalJudgeVerdictCache();
  const posted: string[] = [];
  const input = { org: ORG, kind: "pr.open", args: { what: "repo access", tainted: false }, scopeKey: DM, requestedBy: "U_ANA", channelId: "D_ANA", threadTs: null, chain: { unattended: false } };
  const lifted = await requestApproval(input, { postCard: async (r) => (posted.push(r.id), "1.0") });
  ok(lifted.autoApproved !== undefined && posted.length === 0, "judge: the owner's DM ask is lifted by their DM rule, with no card");
  ok(prompts.some((p) => p.includes("dm.open-pull-request.open")), "judge: the consult's prompt carries the DM rule");
  const before = prompts.length;
  const bob = await requestApproval({ ...input, requestedBy: "U_BOB", args: { what: "repo access 2", tainted: false } }, { postCard: async (r) => (posted.push(r.id), "2.0") });
  ok(bob.autoApproved === undefined && posted.length === 1 && prompts.length === before, "judge (negative control): with no rule for this asker the judge is not consulted and a card posts");
  const replayPrompts = prompts.length;
  const replay = await requestApproval({ ...input, args: JSON.parse(ruleSource!.argsJson) as Record<string, unknown> }, { postCard: async (r) => (posted.push(r.id), "3.0") });
  ok(replay.autoApproved === undefined && posted.length === 2 && prompts.length === replayPrompts, "judge: a rule never lifts again the act its own source card approved (redelivery guard)");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

{
  const viewer: HomeViewer = {
    org: ORG,
    platform: "slack",
    workspace: "T1",
    principalId: "U_ANA",
    personal: { org: ORG, platform: "slack", workspace: "T1", surface: "D_ANA", workspaceKey: "slack/T1", surfaceKey: DM, key: DM },
    trust: "internal",
    domains: [],
  };
  const page = await buildHomeView(viewer);
  const section = page.find((s) => s.id === "rules.dm");
  const item = section?.blocks.find((b) => b.kind === "item");
  ok(item?.kind === "item" && item.ref === ruleHomeRef("dm.open-pull-request.open") && item.actions[0]?.id === RULES_HOME_ACTIONS.remove, "home: the rule is listed with a Remove action");
  ok(item?.kind === "item" && /^[0-9a-f]{64}$/.test(item.ref ?? ""), "home: the rule's ref is a line digest, the only ref grammar the Slack Home wire accepts");
  const other: HomeViewer = { ...viewer, personal: { ...viewer.personal!, surface: "D_BOB", surfaceKey: "slack/T1/D_BOB" } };
  const forged = await runHomeAction(other, RULES_HOME_ACTIONS.remove, ruleHomeRef("dm.open-pull-request.open"));
  ok(forged.notice.includes("nothing to remove") && (await dmRules()).length === 1, "home: another person's page cannot remove this person's rule");
  const bare = await runHomeAction(viewer, RULES_HOME_ACTIONS.remove, "dm.open-pull-request.open");
  ok(bare.notice.includes("nothing to remove") && (await dmRules()).length === 1, "home: a bare rule id is not a ref and removes nothing");
  const removed = await runHomeAction(viewer, RULES_HOME_ACTIONS.remove, ruleHomeRef("dm.open-pull-request.open"));
  ok(removed.notice.startsWith("Removed.") && (await dmRules()).length === 0, "home: Remove takes the rule away at once");
  ok((await dmRulesForProposal(ORG, DM, "U_ANA")).length === 0, "home: after Remove the judge reads no rule");
  const removedRows = (await readAudit({ org: ORG } as never)).filter((x) => x.action === "approval.rule.removed");
  ok(removedRows.length === 1 && removedRows[0]!.detail?.ruleId === "dm.open-pull-request.open", "home: one Remove writes one approval.rule.removed row naming the rule (the forged one writes none)");
}

{
  accessRequests = { adminChannel: "C_ADMIN", configRepo: "acme/app-config", dryRun: false };
  const r = await stored(row({ scopeKey: ROOM, domain: "eng", channelId: "C_ENG", postedTo: ROOM, requestedBy: "U_ANA" }));
  const member = async () => ({ floor: "member" as const, roster: { humanMemberIds: ["U_ANA"], resolved: true, isPrivate: false, hasGuest: false } });
  const guestRoom = async () => ({ floor: "guest" as const, roster: { humanMemberIds: ["U_ANA"], resolved: true, isPrivate: false, hasGuest: true } });
  const unread = async () => ({ floor: "guest" as const, roster: { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false } });
  const base = { clickerId: "U_CARL", clickSurfaceKey: ROOM, clickerIsGuest: false };
  ok((await planAllowRuleClick(r, base, { floor: member as never })).ok, "domain: a member's click in an internal room may propose a rule (any member, not only the asker)");
  const shared = await planAllowRuleClick(r, base, { floor: guestRoom as never });
  ok(!shared.ok && shared.reason === "audience-floor", "domain: an externally shared room gets no rule");
  const unknown = await planAllowRuleClick(r, base, { floor: unread as never });
  ok(!unknown.ok && unknown.reason === "audience-floor", "domain: a room whose members cannot be read gets no rule (fail-closed)");

  const file = ["// header", 'import { defineDomainRules } from "x";', "", "export const DOMAIN_RULES = defineDomainRules([", "]);", ""].join("\n");
  const plan = await planAllowRuleClick(r, base, { floor: member as never });
  assert.ok(plan.ok);
  const puts: { path: string; text: string }[] = [];
  const prs: { title: string; body: string }[] = [];
  const posts: string[] = [];
  const line = await executeDomainRulePr(
    { proposal: plan.proposal, row: r, clickerId: "U_CARL", venue: {} },
    {
      config: accessRequests as never,
      resolveToken: async () => "tok",
      getBranchSha: async ({ branch }) => (branch === "main" ? "sha-main" : null),
      createBranch: async () => undefined as never,
      contents: { getFile: async () => ({ content: file, sha: "f1" }) as never, putFile: async (_repo, path, text) => void puts.push({ path, text }) as never },
      createPr: async ({ title, body }) => (prs.push({ title, body }), { number: 7, url: "https://github.com/acme/app-config/pull/7", updated: false }) as never,
      post: async (_m, b) => (posts.push(b), { ok: true }),
      committer: { name: "bot", email: "bot@example.com" },
    },
  );
  ok(line.includes("pull request #7") && line.includes("after an admin merges it"), "domain: the click opens a pull request and says the merge is the gate");
  ok(puts.length === 1 && puts[0]!.path === "agent/access/domain-rules.ts" && puts[0]!.text.includes('"id":"eng.open-pull-request.open"'), "domain: the pull request adds one line to domain-rules.ts");
  const body = prs[0]!.body;
  ok(body.includes("U_ANA") && body.includes("U_CARL") && body.includes(r.id) && body.includes(`Do thing`), "domain: the body names who asked, who confirmed, the card and the act");
  ok(new URLSearchParams(posts[0]!).get("channel") === "C_ADMIN", "domain: the admin channel is told");
  const proposedRows = (await readAudit({ org: ORG } as never)).filter((x) => x.action === "approval.rule.proposed");
  ok(proposedRows.length === 1 && proposedRows[0]!.detail?.pr === 7 && proposedRows[0]!.detail?.requestedBy === "U_ANA" && proposedRows[0]!.detail?.domain === "eng", "domain: an approval.rule.proposed row names the pull request, the domain and who asked");

  const entry = { domain: "eng", id: "eng.linear.create", rule: allowRuleText("domain", { tool: "linear", action: "create", objects: ["issues"], ops: ["create_issue"] }), subject: { tool: "linear", action: "create", objects: ["issues"], ops: ["create_issue"] } };
  const added = upsertDomainRuleEntry(file, entry);
  ok(added.change === "added", "codemod: a new entry is added");
  ok(upsertDomainRuleEntry(added.text, entry).change === "unchanged", "codemod: the same entry changes nothing");
  const wider = { ...entry, rule: allowRuleText("domain", { tool: "linear", action: "create", objects: ["issues", "projects"], ops: ["create_issue", "create_project"] }) };
  const w = upsertDomainRuleEntry(added.text, wider);
  ok(w.change === "widened" && w.previous?.rule === entry.rule && w.text.split("\n").filter((l) => l.includes("eng.linear")).length === 1, "codemod: the same id is widened in place, never added twice");
  assert.throws(() => upsertDomainRuleEntry(file.replace("]);", "  someCall(),\n]);"), entry), /by hand/u);
  n++;

  const bundles = domainRuleBundles(defineDomainRules([entry]));
  const bindings = domainRuleBindings([entry]);
  ok(bundles[0]?.name === "domain-rules:eng" && bundles[0].preApprovalRules?.[0]?.id === entry.id, "config: a domain's merged rules become its own bundle");
  ok(bindings[0]?.scope.level === "domain" && bindings[0].scope.domain === "eng", "config: the bundle binds at that domain's scope only");
  accessRequests = null;
}

{
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const providers = join(repoRoot, "packages", "providers");
  const fixed = [join(repoRoot, "packages", "core", "agent"), join(repoRoot, "agent"), join(repoRoot, "packages", "create", "template", "agent"), join(repoRoot, "packages", "adapters", "agent")];
  const providerTrees = readdirSync(providers).map((p) => join(providers, p, "agent")).filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  const PROSE_ONLY = new Set(["access/pre-approval-rules.ts", "approvals/allow-rule.ts"].map((f) => join(repoRoot, "packages", "core", "agent", f)));
  const namesWriter = (text: string): boolean => /\bupsertDmRule\b/u.test(text);
  const proseOnly = (text: string): boolean => text.split("\n").every((l) => !namesWriter(l) || (/^\s*(\/\/|\/?\*)/u.test(l) && !/\*\/.*\bupsertDmRule\b/u.test(l)));
  for (const f of PROSE_ONLY) ok(proseOnly(readFileSync(f, "utf8")), `one writer: ${f.slice(repoRoot.length + 1)} names the method on comment lines only`);
  ok(proseOnly("// upsertDmRule in prose\n * upsertDmRule too") && !proseOnly('// fine\nReflect.get(store, "upsertDmRule")(row);') && !proseOnly("store . upsertDmRule(row)") && !proseOnly("/* x */ store.upsertDmRule(row)"), "one writer: a code line naming the method fails the prose-only pin (negative control)");
  const storeFiles = new Set(["store.ts", "sqlite.ts", "postgres.ts"].map((f) => join(repoRoot, "packages", "core", "agent", "operational", f)));
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !storeFiles.has(p) && !PROSE_ONLY.has(p) && !p.includes(`${join("docs", "generated")}`) && namesWriter(readFileSync(p, "utf8"))) callers.push(p.slice(repoRoot.length + 1));
    }
  };
  for (const t of [...fixed, ...providerTrees]) walk(t);
  ok(callers.join(",") === "packages/core/agent/approvals/allow-rule-apply.ts", `one writer: only the click path writes a DM rule (found: ${callers.join(", ")})`);
  const { PROTECTED_HUMAN_ONLY_EXPORTS } = await import("../agent/access/human-only-invariants-manifest.js");
  const names = PROTECTED_HUMAN_ONLY_EXPORTS.flatMap((g) => g.exportNames);
  ok(["applyAllowRule", "planAllowRuleClick", "auditAllowRuleRefused", "executeDomainRulePr"].every((x) => names.includes(x)), "one writer: the rule writers are on the human-only manifest, so no tool may import them");
}

console.log(`allow-rule-test: ${n} assertions passed`);
process.exit(0);
