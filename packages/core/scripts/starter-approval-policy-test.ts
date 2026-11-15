import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-starter-approval-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { getSettings, overrideSettingsForTest, resetSettingsForTest, SETTINGS } = await import("../agent/settings/settings.js");
const {
  clearApprovalJudgeVerdictCache,
  judgeContextOf,
  registerApprovalJudgeCompletion,
  resetApprovalJudgeCompletion,
  runApprovalJudge,
} = await import("../agent/access/approval-judge.js");
const { preApprovalRulesForScopeKey, resolveApproverChain } = await import("../agent/access/approver-chain.js");
const { assertBundlesValid } = await import("../agent/access/bundle.js");
const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { readAudit } = await import("../agent/audit/audit.js");

import type { PreApprovalRule } from "../agent/access/pre-approval-rules.js";
import type { Bundle } from "../agent/access/bundle.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
async function fail(label: string, detail = ""): Promise<never> {
  console.error(`✗ ${label}${detail}`);
  await removeTempDir(tmp);
  process.exit(1);
}
async function ok(cond: boolean, label: string): Promise<void> {
  if (!cond) await fail(label);
  passed += 1;
}
async function eq<T>(actual: T, expected: T, label: string): Promise<void> {
  if (actual !== expected) await fail(label, `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  passed += 1;
}

const templateRulesUrl = new URL("../../create/template/agent/access/pre-approval-rules.ts", import.meta.url).href;
const { PRE_APPROVAL_RULES } = (await import(templateRulesUrl)) as { PRE_APPROVAL_RULES: readonly PreApprovalRule[] };
const ids = PRE_APPROVAL_RULES.map((r) => r.id);
await ok(ids.length > 0, "starter rules: the template ships at least one pre-approval rule");
for (const want of ["pr-asked-for-here", "routine-reports-here", "access-request-asked-for", "connector-write-asked-for-here", "connector-delete-asked-for-here"]) {
  await ok(ids.includes(want), `starter rules: the template ships "${want}"`);
}

const bundles = [
  { name: "approval-policy", preApprovalRules: PRE_APPROVAL_RULES },
  { name: "operator-lowers", connectorOps: [{ connector: "notion", destructive: ["update_block"] }], approvers: [{ name: "lower-update-page", approve: (r: { tool: string }) => (r.tool === "notion__update_page" ? "allow" : "defer") }] },
] as unknown as readonly Bundle[];
assertBundlesValid(bundles);
registerConfig({
  loadBundles: () => bundles,
  loadBindings: () => [{ bundle: "approval-policy", scope: { level: "org" } }, { bundle: "operator-lowers", scope: { level: "org" } }] as never,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "team", reach: ["slack/T1/C_TEAM"] }],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
const resolved = preApprovalRulesForScopeKey("slack/T1/C_TEAM", "team");
await eq(resolved.map((r) => r.id).join(","), ids.join(","), "starter rules: every template rule resolves for a room through the real scope resolver");

await eq(SETTINGS.approvals.judgeMode.shipped, "enforce", "shipped mode: approvals.judgeMode ships enforce");
await eq(getSettings().approvals.judgeMode, "enforce", "shipped mode: with no override the resolved mode IS enforce");

const postCard = async (): Promise<string> => `ts-${Math.random().toString(36).slice(2)}`;
const SCOPE = "slack/T1/C_TEAM";
let nonce = 0;
const base = (kind: string, args: Record<string, unknown>) => ({
  org: "test-org",
  kind,
  channelId: "C_TEAM",
  requestedBy: "U_HUMAN",
  threadTs: null,
  scopeKey: SCOPE,
  domain: "team",
  args: { ...args, nonce: (nonce += 1) },
  chain: { unattended: false },
});
const partition = { org: "test-org", platform: "slack", workspace: "T1", surface: "C_TEAM", surfaceKey: SCOPE };
const routine = (permissions: readonly string[]) =>
  base("routine.create", {
    org: "test-org",
    partition,
    surfaceKey: SCOPE,
    target: { channelId: "C_TEAM" },
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: `Post the morning digest here (${nonce + 1}).`,
    createdBy: "U_HUMAN",
    ...(permissions.length > 0 ? { permissions } : {}),
  });
const purge = () => base("memory.purge", { org: "test-org", partition, bullets: [], locations: [] });
const spend = () => base("spend.set", { org: "test-org", scopeKey: SCOPE, level: "surface", monthlyTokens: 500_000 + nonce, currentCap: null });

function judgeAnswers(verdict: string): { calls: number; prompts: string[] } {
  const seen = { calls: 0, prompts: [] as string[] };
  clearApprovalJudgeVerdictCache();
  registerApprovalJudgeCompletion(async (prompt, pass) => {
    seen.calls += 1;
    seen.prompts.push(prompt);
    return pass === "scrutiny" ? "YES" : verdict;
  });
  return seen;
}

async function verdictRow(kind: string, where: (d: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  const rows = (await readAudit({ org: "test-org" }))
    .filter((r) => r.action === "approval.judge.verdict")
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d.action === kind && where(d));
  if (rows.length !== 1) await fail(`verdict row for ${kind}: expected exactly one matching row, found ${rows.length}`);
  return rows[0]!;
}

{
  const judge = judgeAnswers("VERDICT: allow\nREASON: a person asked for a read-only digest here\nRULE: routine-reports-here");
  const res = await requestApproval(routine([]), { postCard });
  await eq(res.autoApproved?.resolvedBy, "judge", "1 covered: a routine the starter rule covers runs with NO card (the judge lifted it)");
  await ok(judge.prompts.some((p) => ids.every((id) => p.includes(`[${id}]`))), "1 covered: the judge's prompt carried every starter rule, by id");
  const row = await verdictRow("routine.create", (d) => d.verdict === "allow");
  await eq(row.ruleId, "routine-reports-here", "1 covered: the approval.judge.verdict row CITES the starter rule id");
  await eq(row.ruleCitation, "matched", "1 covered: the citation is recorded as matched");
  await eq(row.enforcedVerdict, "allow", "1 covered: the enforced verdict is the allow");

  judgeAnswers("VERDICT: allow\nREASON: the person asked for this change\nRULE: pr-asked-for-here");
  const pr = await resolveApproverChain(
    { tool: "open_pull_request", action: "pr.open", args: { repo: "acme/app", title: "fix typo" }, scopeKey: SCOPE, domain: "team", org: "test-org", unattended: false, tainted: false, principalId: "U_HUMAN" },
    { rules: resolved, judge: true },
  );
  await eq(pr.verdict, "allow", "1 covered: a pull request the starter rule covers resolves allow at the chain");
  await eq(pr.judge?.ruleId, "pr-asked-for-here", "1 covered: …and the consult cites pr-asked-for-here");
}

{
  judgeAnswers("VERDICT: allow\nREASON: looks harmless");
  const uncited = await requestApproval(routine([]), { postCard });
  await eq(uncited.autoApproved, undefined, "2 uncovered: an act no rule covers CARDS although the model said allow");
  const u = await verdictRow("routine.create", (d) => d.ruleCitation === "uncited");
  await eq(u.enforcedVerdict, "ask", "2 uncovered: the enforced verdict is the ask");
  await eq(u.ruleId, undefined, "2 uncovered: the row cites no rule");

  judgeAnswers("VERDICT: allow\nREASON: a rule allows it\nRULE: routines-are-fine");
  const fabricated = await requestApproval(routine([]), { postCard });
  await eq(fabricated.autoApproved, undefined, "2 uncovered: an allow citing a rule that does not exist CARDS");
  const f = await verdictRow("routine.create", (d) => d.ruleCitation === "unmatched");
  await eq(f.enforcedVerdict, "ask", "2 uncovered: the fabricated citation degraded to ask");

  judgeAnswers("VERDICT: allow\nREASON: control\nRULE: routine-reports-here");
  const control = await requestApproval(routine([]), { postCard });
  await eq(control.autoApproved?.resolvedBy, "judge", "2 control: the same act lifts when the citation resolves (so the cards above are the citation rule)");
}

{
  const admin = judgeAnswers("VERDICT: allow\nREASON: a rule covers it\nRULE: pr-asked-for-here");
  const s = await requestApproval(spend(), { postCard });
  await eq(s.autoApproved, undefined, "3 human-only: an admin act (spend.set) CARDS although a cited starter rule would allow it");
  await eq(admin.calls, 0, "3 human-only: the judge model was never called for the admin act");
  const sr = await verdictRow("spend.set");
  await eq(sr.source, "human-only", "3 human-only: the consult row names the human-only class");
  await eq(sr.enforcedVerdict, "ask", "3 human-only: the enforced verdict is the ask");

  const erase = judgeAnswers("VERDICT: allow\nREASON: a rule covers it\nRULE: access-request-asked-for");
  const pu = await requestApproval(purge(), { postCard });
  await eq(pu.autoApproved, undefined, "3 human-only: erasing memory CARDS although a cited starter rule would allow it");
  await eq(erase.calls, 0, "3 human-only: the judge model was never called for the erasure");
  const pr = await verdictRow("memory.purge");
  await eq(pr.source, "human-only", "3 human-only: the erasure's consult row names the human-only class");

  const write = judgeAnswers("VERDICT: allow\nREASON: a rule covers it\nRULE: routine-reports-here");
  const w = await requestApproval(routine(["tool:notion__create_pages"]), { postCard });
  await eq(w.autoApproved, undefined, "3 human-only: a routine declaring a standing WRITE cards although routine-reports-here would cover the routine");
  await eq(write.calls, 0, "3 human-only: the judge model was never called for it");
  const wr = await verdictRow("routine.create", (d) => d.source === "human-only");
  await eq(wr.enforcedVerdict, "ask", "3 human-only: its consult row is the ask");
}

{
  clearApprovalJudgeVerdictCache();
  registerApprovalJudgeCompletion(async () => {
    throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
  });
  const down = await requestApproval(routine([]), { postCard });
  await eq(down.autoApproved, undefined, "4 fail-closed: an UNREACHABLE judge model gives a CARD, not an allow");
  const dr = await verdictRow("routine.create", (d) => d.source === "error");
  await eq(dr.verdict, "defer", "4 fail-closed: the consult row records a defer");
  await eq(dr.enforcedVerdict, "ask", "4 fail-closed: …that stayed the ask");
  await ok(String(dr.reasoning ?? "").includes("ECONNREFUSED"), "4 fail-closed: the row carries the transport's error, so the outage is diagnosable");

  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
  const none = await requestApproval(routine([]), { postCard });
  await eq(none.autoApproved, undefined, "4 fail-closed: NO judge transport gives a card");
  const nr = await verdictRow("routine.create", (d) => d.source === "unavailable");
  await eq(nr.enforcedVerdict, "ask", "4 fail-closed: the unavailable consult stayed the ask");

  clearApprovalJudgeVerdictCache();
  registerApprovalJudgeCompletion(() => new Promise<string>(() => undefined));
  const hung = await runApprovalJudge(
    judgeContextOf({ tool: "create_routine", action: "routine.create", args: {}, unattended: false, tainted: false }, { registryVerdict: "ask" }, resolved),
    { enforce: true, timeoutMs: 40 },
  );
  await eq(hung.verdict, "defer", "4 fail-closed: a judge that never answers defers (⇒ the card)");
  await eq(hung.source, "timeout", "4 fail-closed: …and names the timeout");
  resetApprovalJudgeCompletion();
}

{
  overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  const judge = judgeAnswers("VERDICT: allow\nREASON: would lift\nRULE: routine-reports-here");
  const res = await requestApproval(routine([]), { postCard });
  await eq(res.autoApproved, undefined, "5 off: with judgeMode off the covered routine CARDS");
  await eq(judge.calls, 0, "5 off: …and the judge model is never called");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
  resetSettingsForTest();
}

{
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const { withOeConnectorCard } = await import("../agent/connections/connector-auth.js");
  let call = 0;
  const ATTENDED = { unattended: false, domain: "team" };
  const connectorOp = (over: Record<string, unknown> = {}, chain: Record<string, unknown> = ATTENDED) => {
    call += 1;
    const tool = (over.tool as string | undefined) ?? "notion__create_pages";
    return {
      org: "test-org",
      kind: "op.connector",
      channelId: "C_TEAM",
      requestedBy: "U_HUMAN",
      threadTs: null,
      scopeKey: SCOPE,
      domain: null,
      postedTo: SCOPE,
      chain,
      args: {
        org: "test-org",
        scopeKey: SCOPE,
        tool,
        connection: "notion",
        grain: "call",
        sessionKey: "slack/T1/C_TEAM/1700159720.000100",
        memoKind: `connector.approved:${tool}#digest-${call}`,
        inputPreview: JSON.stringify({ parent: "team-notes", title: `Standup notes ${call}` }),
        requestedBy: "U_HUMAN",
        credential: "domain",
        ...over,
      },
    };
  };
  const COVERED = "VERDICT: allow\nREASON: the person asked for this page in the domain's workspace\nRULE: connector-write-asked-for-here";

  judgeAnswers(COVERED);
  const lifted = connectorOp();
  const res = await requestApproval(lifted as never, { postCard });
  await eq(res.autoApproved?.resolvedBy, "judge", "6 connector: a domain write the starter rule covers runs with NO card (the judge lifted it)");
  const row = await verdictRow("op.connector", (d) => d.verdict === "allow");
  await eq(row.ruleId, "connector-write-asked-for-here", "6 connector: the approval.judge.verdict row CITES connector-write-asked-for-here");
  await eq(row.tool, "notion__create_pages", "6 connector: the consult names the qualified op as its tool");
  const memo = await getOperationalStore().getSessionApproval("test-org", lifted.args.sessionKey, lifted.args.memoKind, new Date().toISOString());
  await eq(memo, null, "6 connector one-call: a judge lift writes NO approval memo, so no later call can spend it");
  const { contradictJudgeAllow } = await import("../agent/approvals/judge-contradiction.js");
  const overrule = await contradictJudgeAllow({ org: "test-org", id: res.id, principalId: "U_HUMAN", route: "click" });
  await eq(overrule.outcome, "recorded", "6 connector: a person can overrule the judge lift of a connector write");
  const contra = (await readAudit({ org: "test-org" })).find((r) => (r.detail as Record<string, unknown> | undefined)?.id === res.id && r.action !== "approval.autoapproved" && (r.detail as Record<string, unknown>).humanAction !== undefined);
  await eq((contra?.detail as Record<string, unknown> | undefined)?.tool, "notion__create_pages", "6 connector: the overrule row names the op that ran");
  const approvedRows = (await readAudit({ org: "test-org" })).filter((r) => r.action === "connector.op_approved");
  await eq((approvedRows.at(-1)?.detail as Record<string, unknown> | undefined)?.decidedBy, "chain:judge", "6 connector: the connector.op_approved row names the judge lift");

  judgeAnswers("VERDICT: allow\nREASON: looks fine");
  const uncited = await requestApproval(connectorOp() as never, { postCard });
  await eq(uncited.autoApproved, undefined, "6 connector: an uncited allow CARDS");
  await eq((await verdictRow("op.connector", (d) => d.ruleCitation === "uncited")).enforcedVerdict, "ask", "6 connector: …and the row is the ask");

  clearApprovalJudgeVerdictCache();
  registerApprovalJudgeCompletion(async () => {
    throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
  });
  const down = await requestApproval(connectorOp() as never, { postCard });
  await eq(down.autoApproved, undefined, "6 connector fail-closed: an UNREACHABLE judge gives a CARD");
  await eq((await verdictRow("op.connector", (d) => d.source === "error")).enforcedVerdict, "ask", "6 connector fail-closed: the error consult stayed the ask");

  const DELETE = { tool: "notion__delete_block", grain: "destructive" };
  const never: readonly [string, Record<string, unknown>, Record<string, unknown>?][] = [
    ["a card frozen with the old blanket grain", { grain: "once" }],
    ["a card for an op whose name reads as a read", { tool: "notion__search" }],
    ["an op with no recognised verb (execute_sql)", { tool: "supabase__execute_sql", grain: "destructive", opTier: "destructive" }],
    ["an op with no recognised verb a server called a write", { tool: "notion__frobnicate_widget", opTier: "write" }],
    ["a delete on a person's own account", { ...DELETE, credential: "personal" }],
    ["a delete in an unattended run", DELETE, { unattended: true, domain: "team" }],
    ["a delete in a room with no single domain", DELETE, { unattended: false }],
    ["a delete whose input the card truncated", { ...DELETE, inputPreview: `${"x".repeat(600)}…` }],
    ["a person's own account", { credential: "personal" }],
    ["an unknown credential", { credential: undefined }],
    ["an unattended run", {}, { unattended: true, domain: "team" }],
    ["a chain bag that never says attended", {}, { domain: "team" }],
    ["a room with no single domain", {}, { unattended: false }],
    ["an input the card truncated", { inputPreview: `${"x".repeat(600)}…` }],
  ];
  for (const [what, over, chain] of never) {
    const judge = judgeAnswers(COVERED);
    const before = (await readAudit({ org: "test-org" })).filter((r) => r.action === "approval.chain").length;
    const r = await requestApproval(connectorOp(over, chain ?? ATTENDED) as never, { postCard });
    await eq(r.autoApproved, undefined, `6 connector human-only: ${what} CARDS although the starter rule would cover it`);
    await eq(judge.calls, 0, `6 connector human-only: the judge model is never called for ${what}`);
    const after = (await readAudit({ org: "test-org" })).filter((r) => r.action === "approval.chain").length;
    await eq(after, before, `6 connector human-only: ${what} never enters the approver chain (its old card road)`);
  }

  judgeAnswers(COVERED);
  const ctxFor = (title: string) =>
    judgeContextOf({ tool: "notion__create_pages", action: "op.connector", args: { title }, unattended: false, tainted: false }, { registryVerdict: "ask" }, resolved);
  const one = await runApprovalJudge(ctxFor("a"), { enforce: true });
  const two = await runApprovalJudge(ctxFor("b"), { enforce: true });
  await ok(one.cacheKey.startsWith("notion__create_pages#") && one.cacheKey !== two.cacheKey, "6 connector cache: the enforced cache key carries the input digest");

  {
    const { disarmApprovalJudge, rearmApprovalJudge } = await import("../agent/approvals/judge-contradiction.js");
    await disarmApprovalJudge({ org: "test-org", domain: "team", principalId: "U_OPS" });
    const disarmed = judgeAnswers(COVERED);
    const r = await requestApproval(connectorOp() as never, { postCard });
    await eq(r.autoApproved, undefined, "6 connector disarm: a domain disarm CARDS a covered connector write");
    await eq(disarmed.calls, 0, "6 connector disarm: …and the judge model is never called");
    await eq((await verdictRow("op.connector", (d) => d.source === "admin-disarm")).domain, "team", "6 connector disarm: the consult row names the disarmed domain");
    await rearmApprovalJudge({ org: "test-org", domain: "team", principalId: "U_OPS" });
    judgeAnswers(COVERED);
    const again = await requestApproval(connectorOp() as never, { postCard });
    await eq(again.autoApproved?.resolvedBy, "judge", "6 connector disarm control: re-armed, the same write lifts again");

    await getOperationalStore().setHalt("test-org", { orgWide: false, level: "domain", scopeKey: "team" }, { setBy: "U_OPS" });
    const halted = judgeAnswers(COVERED);
    let refused = false;
    try {
      await requestApproval(connectorOp() as never, { postCard });
      refused = false;
    } catch {
      refused = true;
    }
    await eq(refused, true, "6 connector halt: a domain halt REFUSES a covered connector write (no lift, no card)");
    void halted;
    await getOperationalStore().clearHalt("test-org", { orgWide: false, level: "domain", scopeKey: "team" }, { clearedBy: "U_OPS" } as never);
  }

  const COVERED_DELETE = "VERDICT: allow\nREASON: the person asked to delete exactly this block\nRULE: connector-delete-asked-for-here";
  for (const [what, over] of [
    ["a delete frozen with the destructive grain", DELETE],
    ["a delete on the flag-off blanket grain", { tool: "notion__delete_block" }],
    ["a delete-named op frozen with opTier destructive", { ...DELETE, opTier: "destructive" }],
  ] as const) {
    const judge = judgeAnswers(COVERED_DELETE);
    const r = await requestApproval(connectorOp(over) as never, { postCard });
    await eq(r.autoApproved?.resolvedBy, "judge", `6i connector delete: ${what} the starter delete rule covers runs with NO card`);
    await eq(judge.calls > 0, true, `6i connector delete: the judge model was asked about ${what}`);
  }
  const deleteRows = (await readAudit({ org: "test-org" }))
    .filter((r) => r.action === "approval.judge.verdict")
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d.action === "op.connector" && d.verdict === "allow" && d.tool === "notion__delete_block");
  await eq(deleteRows.length, 3, "6i connector delete: one allow row per lifted delete");
  await eq(deleteRows.every((d) => d.ruleId === "connector-delete-asked-for-here"), true, "6i connector delete: each verdict row CITES connector-delete-asked-for-here");

  for (const [what, over, chain, rule] of [
    ["a write in a tainted turn", {}, { ...ATTENDED, tainted: true }, COVERED],
    ["a write on a card frozen as tainted", { tainted: true }, ATTENDED, COVERED],
    ["a delete in a tainted turn", DELETE, { ...ATTENDED, tainted: true }, COVERED_DELETE],
  ] as const) {
    clearApprovalJudgeVerdictCache();
    const judge = judgeAnswers(rule);
    const r = await requestApproval(connectorOp(over, chain) as never, { postCard });
    await eq(r.autoApproved?.resolvedBy, "judge", `6j connector, no taint fence: ${what} is lifted by the judge under a cited rule`);
    await eq(judge.calls > 0, true, `6j connector, no taint fence: the judge model was asked about ${what}`);
  }
  {
    const judge = judgeAnswers(COVERED);
    const before = (await readAudit({ org: "test-org" })).filter((r) => r.action === "approval.chain").length;
    const r = await requestApproval(connectorOp({ tool: "notion__append_block", opTier: "destructive" }) as never, { postCard });
    await eq(r.autoApproved, undefined, "6i connector delete: a write-named op frozen with opTier destructive CARDS although the write rule is cited");
    await eq(judge.calls, 0, "6i connector delete: …and the judge model is never asked");
    await eq((await readAudit({ org: "test-org" })).filter((r) => r.action === "approval.chain").length, before, "6i connector delete: …it never enters the chain");
    const odd = judgeAnswers(COVERED);
    await eq((await requestApproval(connectorOp({ opTier: "bogus" }) as never, { postCard })).autoApproved, undefined, "6i connector delete: an unrecognised frozen opTier CARDS (fail closed)");
    await eq(odd.calls, 0, "6i connector delete: …with no judge call");
    judgeAnswers(COVERED);
    const control = await requestApproval(connectorOp({ tool: "notion__append_block", opTier: "write" }) as never, { postCard });
    await eq(control.autoApproved?.resolvedBy, "judge", "6i control: the same write-named op frozen with opTier write still lifts under the write rule");
  }
  {
    const { setApprovalJudgeCacheStoreForTest } = await import("../agent/access/approval-judge.js");
    const cache = new Map<string, never>();
    setApprovalJudgeCacheStoreForTest({ get: (k: string) => cache.get(k), set: (k: string, e: unknown) => void cache.set(k, e as never), delete: (k: string) => void cache.delete(k) } as never);
    const judge = judgeAnswers(COVERED_DELETE);
    const same = connectorOp(DELETE);
    await eq((await requestApproval(same as never, { postCard })).autoApproved?.resolvedBy, "judge", "6i cache: the first identical delete lifts");
    const callsAfterFirst = judge.calls;
    await eq((await requestApproval({ ...same } as never, { postCard })).autoApproved?.resolvedBy, "judge", "6i cache: the second identical delete lifts too…");
    await eq(judge.calls > callsAfterFirst, true, "🔴 6i cache: …but only because the model was ASKED AGAIN, never from a cached allow");
    await eq(cache.size, 0, "6i cache: no connector allow was written to the session cache");
    setApprovalJudgeCacheStoreForTest(undefined);
  }
  judgeAnswers("VERDICT: allow\nREASON: looks fine");
  const uncitedDelete = await requestApproval(connectorOp(DELETE) as never, { postCard });
  await eq(uncitedDelete.autoApproved, undefined, "6i connector delete: an uncited allow of a delete CARDS");
  judgeAnswers("VERDICT: ask\nREASON: the person did not name this block");
  const askedDelete = await requestApproval(connectorOp(DELETE) as never, { postCard });
  await eq(askedDelete.autoApproved, undefined, "6i connector delete: a judge `ask` on a delete CARDS");

  judgeAnswers("VERDICT: allow\nREASON: looks fine");
  const lowered = await requestApproval(connectorOp({ tool: "notion__update_page" }) as never, { postCard });
  await eq(lowered.autoApproved, undefined, "6 connector: an OPERATOR approver's allow does not lift a connector card (only the judge does)");

  let offers = 0;
  const offered: Record<string, unknown>[] = [];
  const seam = withOeConnectorCard(() => "user-approval" as never, {
    store: { getSessionApproval: async () => null, markEventSeen: async () => true, hasEventSeen: async () => false } as never,
    offer: (async (o: Record<string, unknown>) => {
      offers += 1;
      offered.push(o);
      return { outcome: "approved" };
    }) as never,
    grantScope: () => ({ key: "slack/T1/C_TEAM/1700159720.000100", reach: "call" }),
    tainted: () => false,
    credentialOf: async () => "domain",
  } as never);
  const opCtx = { toolName: "notion__create_pages", toolInput: { title: "x" }, approvedTools: new Set<string>(), session: { auth: {} } } as never;
  await eq(await seam(opCtx), "not-applicable", "6 connector seam: a judge lift lets this call run");
  await eq(await seam(opCtx), "not-applicable", "6 connector seam: the next call runs only through a NEW offer…");
  await eq(offers, 2, "6 connector seam: …so each call was judged again (one call per allow)");
  await eq(offered[0]?.credential, "domain", "6 connector seam: the offer carries the credential plane");
  await eq(getSettings().connectors.opTiering, true, "6 connector seam: (premise) op tiering ships on");
  overrideSettingsForTest({ connectors: { opTiering: false, userPrincipal: false } } as never);
  await seam(opCtx);
  await eq(offered[2]?.credential, "domain", "6 connector seam: with op tiering OFF (the blanket card) the offer carries the plane too");
  resetSettingsForTest();
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

{
  const { createRequire } = await import("node:module");
  const { dirname, join: joinPath } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = (await import(pathToFileURL(joinPath(eveRoot, "dist/src/context/container.js")).href)) as {
    ContextContainer: new () => unknown;
    contextStorage: { run<T>(c: unknown, fn: () => Promise<T>): Promise<T> };
  };
  const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);
  const COVERED_ROUTINE = "VERDICT: allow\nREASON: the person asked for this routine\nRULE: routine-reports-here";

  await inSession(async () => {
    const judge = judgeAnswers(COVERED_ROUTINE);
    const a = routine([]);
    const first = await requestApproval(a, { postCard });
    await eq(first.autoApproved?.resolvedBy, "judge", "7 cache: routine A lifts (the judge allowed it)");
    const afterA = judge.calls;
    await ok(afterA > 0, "7 cache: the first lift consulted the judge model");

    const repeat = await requestApproval(a, { postCard });
    await eq(repeat.autoApproved?.resolvedBy, "judge", "7 cache control: the same act lifts again");
    await eq(judge.calls, afterA, "7 cache control: …from the session cache, with NO new model call (so the store is live)");
    await eq((await verdictRow("routine.create", (d) => d.cacheHit === true)).ruleId, "routine-reports-here", "7 cache control: the cache hit still cites its rule");

    const b = routine([]);
    await requestApproval(b, { postCard });
    await ok(judge.calls > afterA, "7 cache: a different routine B in the same session is JUDGED AGAIN, never answered by A's cached allow");
    const afterB = judge.calls;

    await requestApproval({ ...a, chain: { unattended: true } }, { postCard }).catch(() => undefined);
    await ok(judge.calls > afterB, "7 cache: the same act in an UNATTENDED turn is judged again, never answered by the attended allow");
    const afterUnattended = judge.calls;

    await requestApproval({ ...a, requestedBy: "U_OTHER" }, { postCard });
    await ok(judge.calls > afterUnattended, "7 cache: the same act for ANOTHER requester is judged again");
  });

  const { recordRequesterMessage } = await import("../agent/access/requester-messages.js");
  const { noteContinuationTurn } = await import("../agent/access/continuation-turn-state.js");
  await inSession(async () => {
    const turnCtx = (turn: string) => ({ session: { id: "wrun_test", turn: { id: turn } } }) as never;
    noteContinuationTurn(turnCtx("turn_1"));
    recordRequesterMessage("turn_1", "please add a digest routine here");
    const judge = judgeAnswers(COVERED_ROUTINE);
    await requestApproval(routine([]), { postCard });
    const now = judge.prompts.at(-1) ?? "";
    await ok(now.includes("Requester's visible messages:\n> please add a digest routine here"), "7 backscroll: this turn's ask is rendered as the requester's message");
    await ok(!now.includes("EARLIER turns"), "7 backscroll: …and nothing is marked earlier in the same turn");

    noteContinuationTurn(turnCtx("turn_2"));
    const later = judgeAnswers(COVERED_ROUTINE);
    await requestApproval(routine([]), { postCard });
    const p = later.prompts.at(-1) ?? "";
    await ok(!p.includes("Requester's visible messages:"), "7 backscroll: in a later turn the old ask is NOT rendered as this turn's message");
    await ok(p.includes("EARLIER turns (context only") && p.includes("> please add a digest routine here"), "7 backscroll: …it is rendered as earlier context");
  });
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

await removeTempDir(tmp);
console.log(`✓ starter approval policy (OPE-2366): ${passed} assertions — shipped enforce, starter rules cited, uncovered and human-only acts card, the judge fails closed, connector writes judged per call, cached allows bound to one act, backscroll marked earlier`);
