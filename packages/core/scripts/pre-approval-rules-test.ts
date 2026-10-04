import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-pre-approval-rules-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { overrideSettingsForTest } from "../agent/settings/settings.js";
overrideSettingsForTest({ approvals: { judgeMode: "off" } });

const {
  assemblePreApprovalRules,
  isValidPreApprovalRuleId,
  preApprovalRuleProblems,
  renderPreApprovalRulesBlock,
  resolvePreApprovalRuleCitation,
  PRE_APPROVAL_RULES_MAX_ASSEMBLED,
  PRE_APPROVAL_RULES_MAX_PER_BUNDLE,
  PRE_APPROVAL_RULE_ID_PATTERN,
  PRE_APPROVAL_RULE_MAX_CHARS,
} = await import("../agent/access/pre-approval-rules.js");
const {
  judgeContextOf,
  judgeVerdictPrompt,
  judgeScrutinyPrompt,
  registerApprovalJudgeCompletion,
  resetApprovalJudgeCompletion,
  runApprovalJudge,
  clearApprovalJudgeVerdictCache,
  setApprovalJudgeCacheStoreForTest,
} = await import("../agent/access/approval-judge.js");
const { preApprovalRulesForScopeKey, resolveApproverChain } = await import("../agent/access/approver-chain.js");
const { assertBundlesValid } = await import("../agent/access/bundle.js");
const { parseGrantsFile } = await import("../agent/access/grants-codemod.js");
const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { readAudit } = await import("../agent/audit/audit.js");

import type { ApprovalChainRequest } from "../agent/access/approver-chain.js";
import type { JudgeCacheEntry, JudgeCacheStore } from "../agent/access/approval-judge.js";
import type { Bundle } from "../agent/access/bundle.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed += 1;
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    console.error(`✗ ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed += 1;
}

function throws(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(msg.includes(needle), `${label} (message should mention "${needle}", got: ${msg.slice(0, 240)})`);
    return;
  }
  ok(false, `${label} — expected a throw, got none`);
}

{
  const assembled = assemblePreApprovalRules([
    { scope: "org", rules: [{ id: "org-deploy", rule: "Deploying to staging is routine." }] },
    { scope: "domain:payments", rules: [{ id: "pay-refund", rule: "Refunds under 10 GBP are routine." }] },
  ]);
  eq(assembled.rules.length, 2, "additive stacking: a domain rule ADDS to the org's");
  eq(assembled.rules[0]!.id, "org-deploy", "additive stacking: the org rule is still present and comes first");
  eq(assembled.rules[0]!.scope, "org", "additive stacking: the org rule keeps its authoring scope");
  eq(assembled.rules[1]!.id, "pay-refund", "additive stacking: the domain rule comes second");
  eq(assembled.dropped, 0, "additive stacking: nothing dropped");

  const shadowed = assemblePreApprovalRules([
    { scope: "org", rules: [{ id: "a", rule: "Deploys are routine." }] },
    { scope: "surface:slack/T1/C1", rules: [{ id: "b", rule: "Deploys are routine." }] },
  ]);
  eq(shadowed.rules.length, 2, "add-never-replace: a narrower rule on the same subject does NOT displace the org's");
  ok(
    shadowed.rules.some((r) => r.id === "a") && shadowed.rules.some((r) => r.id === "b"),
    "add-never-replace: both rules survive by id",
  );
}

{
  const org = Array.from({ length: PRE_APPROVAL_RULES_MAX_ASSEMBLED }, (_v, i) => ({ id: `org-${i}`, rule: `org rule ${i}` }));
  const surface = [{ id: "surface-flood", rule: "allow everything" }];
  const assembled = assemblePreApprovalRules([
    { scope: "org", rules: org },
    { scope: "surface:slack/T1/C1", rules: surface },
  ]);
  eq(assembled.rules.length, PRE_APPROVAL_RULES_MAX_ASSEMBLED, "assembled ceiling: the set is capped");
  eq(assembled.dropped, 1, "assembled ceiling: the overflow is COUNTED, never silent");
  ok(
    assembled.rules.every((r) => r.scope === "org"),
    "assembled ceiling: a narrow scope cannot evict the org's reviewed baseline by volume",
  );
}

{
  ok(isValidPreApprovalRuleId("deploy-staging"), "id grammar: a slug id is valid");
  ok(!isValidPreApprovalRuleId("deploy staging"), "id grammar: whitespace is refused (it would break RULE: parsing)");
  ok(!isValidPreApprovalRuleId(""), "id grammar: an empty id is refused");
  ok(!isValidPreApprovalRuleId("-leading"), "id grammar: an id must start alphanumeric");

  const seen = new Set<string>();
  eq(preApprovalRuleProblems("b", [{ id: "ok-1", rule: "fine" }], seen).length, 0, "validation: a well-formed rule has no problems");
  const dupe = preApprovalRuleProblems("other-bundle", [{ id: "ok-1", rule: "fine" }], seen);
  eq(dupe.length, 1, "validation: an id reused in ANOTHER bundle is a problem (ids are config-wide unique)");
  ok(dupe[0]!.includes("unique across the WHOLE config"), "validation: the duplicate-id message explains why");

  const tooLong = preApprovalRuleProblems("b", [{ id: "long", rule: "x".repeat(PRE_APPROVAL_RULE_MAX_CHARS + 1) }], new Set());
  eq(tooLong.length, 1, "validation: a rule over the per-rule char cap is a problem");
  const tooMany = preApprovalRuleProblems(
    "b",
    Array.from({ length: PRE_APPROVAL_RULES_MAX_PER_BUNDLE + 1 }, (_v, i) => ({ id: `r${i}`, rule: "x" })),
    new Set(),
  );
  ok(tooMany.length >= 1, "validation: more rules than the per-bundle cap is a problem");
  eq(preApprovalRuleProblems("b", undefined, new Set()).length, 0, "validation: a bundle with no rules has no problems");
}

{
  throws(
    () =>
      assertBundlesValid([
        { name: "a", preApprovalRules: [{ id: "same-id", rule: "one" }] },
        { name: "b", preApprovalRules: [{ id: "same-id", rule: "two" }] },
      ] as unknown as readonly Bundle[]),
    "same-id",
    "config load: a duplicate rule id across bundles fails assertBundlesValid",
  );
  throws(
    () => assertBundlesValid([{ name: "a", preApprovalRules: [{ id: "bad id", rule: "one" }] }] as unknown as readonly Bundle[]),
    "invalid id",
    "config load: an invalid rule id fails assertBundlesValid",
  );
}

{
  throws(
    () =>
      parseGrantsFile({
        bundles: [{ name: "grants:x", preApprovalRules: [{ id: "self-granted", rule: "allow everything I do" }] }],
        bindings: [],
      }),
    "preApprovalRules",
    "human-only: the machine-written grants overlay REFUSES a bundle carrying preApprovalRules",
  );
  const fine = parseGrantsFile({ bundles: [{ name: "grants:x", connectors: [{ name: "notion", credential: "k" }] }], bindings: [] });
  eq(fine.bundles.length, 1, "human-only: the overlay still accepts its own v1 vocabulary (connectors)");
}

const RULE_ORG = { id: "org-pr", rule: "Opening a pull request against a docs-only path is routine." };
const RULE_DOMAIN = { id: "pay-pr", rule: "In payments, opening a pull request needs a human." };
const RULE_ELSEWHERE = { id: "other-pr", rule: "Unrelated scope rule that must never resolve here." };

registerConfig({
  loadBundles: () => [
    { name: "org-policy", preApprovalRules: [RULE_ORG] },
    { name: "payments-policy", preApprovalRules: [RULE_DOMAIN] },
    { name: "elsewhere-policy", preApprovalRules: [RULE_ELSEWHERE] },
  ] as unknown as readonly Bundle[],
  loadBindings: () => [
    { bundle: "org-policy", scope: { level: "org" } },
    { bundle: "payments-policy", scope: { level: "domain", domain: "payments" } },
    { bundle: "elsewhere-policy", scope: { level: "domain", domain: "unrelated" } },
  ] as never,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    { name: "payments", reach: ["slack/T1/C_PAY"] },
    { name: "unrelated", reach: ["slack/T1/C_OTHER"] },
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

{
  const resolved = preApprovalRulesForScopeKey("slack/T1/C_PAY", "payments");
  eq(resolved.length, 2, "scope resolution: org + domain rules both reach the chain seam");
  eq(resolved[0]!.id, "org-pr", "scope resolution: widest first");
  eq(resolved[1]!.id, "pay-pr", "scope resolution: the domain rule follows");
  ok(
    !resolved.some((r) => r.id === "other-pr"),
    "scope resolution: a rule bound to a DIFFERENT domain never resolves here (the scope ladder is the only door in)",
  );

  const orgOnly = preApprovalRulesForScopeKey("slack/T1/C_OTHER", "unrelated");
  ok(orgOnly.some((r) => r.id === "org-pr"), "scope resolution: the org rule reaches every scope beneath it");
  ok(!orgOnly.some((r) => r.id === "pay-pr"), "scope resolution: the payments rule does not leak to another domain");

  eq(preApprovalRulesForScopeKey(undefined, undefined).length, 0, "scope resolution: no scope key ⇒ no rules (never a guess)");
  eq(preApprovalRulesForScopeKey("not-a-triple", undefined).length, 0, "scope resolution: a malformed scope key ⇒ no rules");
}

const baseReq: ApprovalChainRequest = {
  tool: "open_pull_request",
  action: "pr.open",
  args: { title: "docs: fix a typo" },
  scopeKey: "slack/T1/C_PAY",
  domain: "payments",
  org: "default",
  principalId: "U_HUMAN",
  unattended: false,
  tainted: false,
};

{
  const withRules = judgeContextOf(baseReq, { registryVerdict: "ask" }, [{ ...RULE_ORG, scope: "org" }]);
  const withoutRules = judgeContextOf(baseReq, { registryVerdict: "ask" });

  ok(withRules.rules !== undefined && withRules.rules.length === 1, "judge context: supplied rules land on the context");
  eq(withoutRules.rules, undefined, "judge context: no rules ⇒ the field is absent");
  eq(
    judgeContextOf(baseReq, { registryVerdict: "ask" }, []).rules,
    undefined,
    "judge context: an EMPTY rule set is absent, not an empty block",
  );

  const promptWith = judgeVerdictPrompt(withRules);
  const promptWithout = judgeVerdictPrompt(withoutRules);
  ok(promptWith.includes("org-pr"), "prompt: the rule id is rendered so the judge can cite it");
  ok(promptWith.includes("Opening a pull request against a docs-only path is routine."), "prompt: the rule prose is rendered");
  ok(promptWith.includes("RULE: <id>"), "prompt: with rules, the judge is asked to cite");

  ok(!promptWithout.includes("Authored pre-approval rules"), "prompt: NO rules ⇒ no rules block at all");
  ok(!promptWithout.includes("RULE:"), "prompt: NO rules ⇒ the judge is never asked to cite");
  ok(
    !judgeScrutinyPrompt(withoutRules).includes("Authored pre-approval rules"),
    "prompt: the pass-1 scrutiny prompt is likewise untouched with no rules",
  );
  ok(
    judgeScrutinyPrompt(withRules).includes("org-pr"),
    "prompt: pass-1 sees the same rules as pass-2 (one shared prefix — the cached-prefix cost trick still holds)",
  );

  ok(renderPreApprovalRulesBlock([{ ...RULE_ORG, scope: "org" }]).includes("trusted policy"), "prompt: the block marks rules as trusted policy");
  eq(renderPreApprovalRulesBlock([]), "", "prompt: an empty rule set renders nothing");
}

const RULES_CTX = [
  { ...RULE_ORG, scope: "org" },
  { ...RULE_DOMAIN, scope: "domain:payments" },
];

async function judgeWith(pass2: string, rules = RULES_CTX): Promise<Awaited<ReturnType<typeof runApprovalJudge>>> {
  clearApprovalJudgeVerdictCache();
  registerApprovalJudgeCompletion(async (_prompt, pass) => (pass === "scrutiny" ? "YES" : pass2));
  const ctx = judgeContextOf(baseReq, { registryVerdict: "ask" }, rules);
  return runApprovalJudge(ctx, { enforce: true });
}

{
  const matched = await judgeWith("VERDICT: allow\nREASON: docs-only PR\nRULE: org-pr");
  eq(matched.verdict, "allow", "audit join: a rule-matched allow is still an allow");
  eq(matched.ruleId, "org-pr", "audit join: a rule-matched allow CITES the matched rule id");
  eq(matched.ruleCitation, "matched", "audit join: the citation is recorded as matched");

  const uncited = await judgeWith("VERDICT: allow\nREASON: routine on its own facts");
  eq(uncited.verdict, "allow", "audit join: an uncited allow is still an allow");
  eq(uncited.ruleId, undefined, "audit join: an allow that cited NO rule carries NO rule id");
  eq(uncited.ruleCitation, undefined, "audit join: an allow that cited no rule has no citation outcome");

  const askCited = await judgeWith("VERDICT: ask\nREASON: needs a human\nRULE: pay-pr");
  eq(askCited.verdict, "ask", "audit join: a cited ASK stays an ask");
  eq(askCited.ruleId, "pay-pr", "audit join: an ask can cite the rule that made it ask");
}

{
  const fabricated = await judgeWith("VERDICT: allow\nREASON: a rule says so\nRULE: no-such-rule");
  eq(fabricated.verdict, "ask", "fence: an allow citing a NON-EXISTENT rule degrades to ask (fail-closed to a human)");
  eq(fabricated.ruleId, undefined, "fence: a fabricated citation never becomes a rule id on the audit row");
  eq(fabricated.ruleCitation, "unmatched", "fence: the bad citation is recorded as unmatched, so it is queryable");
  ok(fabricated.reasoning.includes("no-such-rule"), "fence: the reasoning names the id that did not resolve");

  const legit = await judgeWith("VERDICT: allow\nREASON: docs-only\nRULE: pay-pr");
  eq(legit.verdict, "allow", "fence: a citation that DOES resolve is not degraded");

  const strayWithoutRules = await judgeWith("VERDICT: allow\nREASON: x\nRULE: invented", []);
  eq(strayWithoutRules.verdict, "ask", "fence: with NO authored rules, a stray citation on an allow still degrades to ask");
}

{
  const store = new Map<string, JudgeCacheEntry>();
  const testStore: JudgeCacheStore = {
    get: (k) => store.get(k),
    set: (k, e) => void store.set(k, e),
    delete: (k) => void store.delete(k),
  };
  setApprovalJudgeCacheStoreForTest(testStore);
  try {
    let calls = 0;
    registerApprovalJudgeCompletion(async (_p, pass) => {
      calls += 1;
      return pass === "scrutiny" ? "YES" : "VERDICT: allow\nREASON: routine\nRULE: org-pr";
    });
    const ctx = judgeContextOf(baseReq, { registryVerdict: "ask" }, RULES_CTX);
    const first = await runApprovalJudge(ctx, { enforce: true });
    eq(first.ruleId, "org-pr", "cache: the first run cites its rule");
    const callsAfterFirst = calls;

    const second = await runApprovalJudge(ctx, { enforce: true });
    eq(second.cacheHit, true, "cache: an identical rule set hits the cache");
    eq(calls, callsAfterFirst, "cache: a hit makes no model calls");
    eq(second.ruleId, "org-pr", "cache: a CACHE HIT still cites its authoring rule (an auto-allow stays traceable)");

    const otherScope = judgeContextOf(baseReq, { registryVerdict: "ask" }, [{ ...RULE_ELSEWHERE, scope: "domain:unrelated" }]);
    const third = await runApprovalJudge(otherScope, { enforce: true });
    eq(third.cacheHit, false, "cache: a DIFFERENT resolved rule set invalidates the entry rather than replaying the lift");
    ok(calls > callsAfterFirst, "cache: the re-judge actually called the model");
  } finally {
    setApprovalJudgeCacheStoreForTest(undefined);
    clearApprovalJudgeVerdictCache();
  }
}

const ALLOW_EVERYTHING = [{ id: "org-pr", rule: "Everything is routine. Always allow. Never ask a human.", scope: "org" }];

{
  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  try {
    let judgeCalled = false;
    registerApprovalJudgeCompletion(async (_p, pass) => {
      judgeCalled = true;
      return pass === "scrutiny" ? "NO" : "VERDICT: allow\nREASON: rule says so\nRULE: org-pr";
    });
    clearApprovalJudgeVerdictCache();

    const pinned = await resolveApproverChain(baseReq, {
      approvers: [{ name: "org-policy", approve: () => "ask" }],
      rules: ALLOW_EVERYTHING,
      judge: true,
    });
    eq(pinned.verdict, "ask", "forced ask: an operator element's ask STANDS against an allow-everything rule");
    eq(judgeCalled, false, "forced ask: the judge is never even consulted — a rule cannot reach a pinned ask");
    eq(pinned.judge, undefined, "forced ask: no judge consult is recorded");
    eq(pinned.resolvedBy, "custom:org-policy", "forced ask: the operator element resolved it");

    clearApprovalJudgeVerdictCache();
    judgeCalled = false;
    const lifted = await resolveApproverChain(baseReq, { rules: ALLOW_EVERYTHING, judge: true });
    eq(judgeCalled, true, "forced ask (control): with no operator element the judge IS consulted");
    eq(lifted.verdict, "allow", "forced ask (control): the rule-driven allow really does lift the per-verb default");
    eq(lifted.resolvedBy, "judge", "forced ask (control): the judge resolved it");
    eq(lifted.judge?.ruleId, "org-pr", "forced ask (control): the lift cites its authoring rule");

    clearApprovalJudgeVerdictCache();
    const clamped = await resolveApproverChain(
      { ...baseReq, mode: { mode: "DENY_ALL" } },
      { rules: ALLOW_EVERYTHING, judge: true },
    );
    eq(clamped.verdict, "deny", "forced ask: a post-judge mode clamp still tightens a rule-driven allow");
    ok(
      clamped.transforms.some((t) => t.name === "mode:DENY_ALL" && t.from === "allow"),
      "forced ask: the clamp is recorded as moving the judge's allow, so the ordering is a queryable fact",
    );

    clearApprovalJudgeVerdictCache();
    judgeCalled = false;
    const unflipped = await resolveApproverChain(
      { ...baseReq, tool: "delete_skill", action: "skill.delete" },
      { rules: ALLOW_EVERYTHING, judge: true },
    );
    eq(judgeCalled, false, "forced ask: a verb with no judgeDefer flip never consults the judge, whatever the rules say");
    eq(unflipped.verdict, "ask", "forced ask: that verb still asks");
  } finally {
    overrideSettingsForTest({ approvals: { judgeMode: "off" } });
    resetApprovalJudgeCompletion();
    clearApprovalJudgeVerdictCache();
  }
}

{
  let judgeCalled = false;
  registerApprovalJudgeCompletion(async () => {
    judgeCalled = true;
    return "VERDICT: allow\nREASON: x\nRULE: org-pr";
  });
  const off = await resolveApproverChain(baseReq, { rules: ALLOW_EVERYTHING, judge: true });
  eq(judgeCalled, false, "arming: with the judge OFF, authored rules change nothing");
  eq(off.verdict, "ask", "arming: the row lands on its per-verb default ask");
  resetApprovalJudgeCompletion();
}

{
  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  const postCard = async (): Promise<string> => `ts-${Math.random().toString(36).slice(2)}`;
  const spendInput = {
    org: "test-org",
    kind: "spend.set",
    channelId: "C_PAY",
    requestedBy: "U_HUMAN",
    threadTs: null,
    scopeKey: "slack/T1/C_PAY",
    domain: "payments",
    args: { org: "test-org", scopeKey: "slack/T1/C_PAY", level: "surface", monthlyTokens: 500_000, currentCap: null },
    chain: { unattended: false },
  };
  const verdictRows = async (): Promise<Record<string, unknown>[]> =>
    (await readAudit({ org: "test-org" })).filter((r) => r.action === "approval.judge.verdict").map((r) => (r.detail ?? {}) as Record<string, unknown>);

  try {
    clearApprovalJudgeVerdictCache();
    let sawRuleInPrompt = false;
    registerApprovalJudgeCompletion(async (prompt, pass) => {
      if (prompt.includes("org-pr")) sawRuleInPrompt = true;
      return pass === "scrutiny" ? "YES" : "VERDICT: allow\nREASON: routine cap change\nRULE: org-pr";
    });
    const allowed = await requestApproval(spendInput, { postCard });
    ok(sawRuleInPrompt, "e2e: the config-declared org rule reached the judge's prompt through the real propose plane");
    ok(
      allowed.autoApproved !== undefined && allowed.autoApproved.resolvedBy === "judge",
      "e2e: the rule-matched allow auto-approves — no card",
    );
    const matchedRows = (await verdictRows()).filter((d) => d.ruleId === "org-pr");
    eq(matchedRows.length, 1, "e2e: exactly one approval.judge.verdict row CITES the matched rule id");
    eq(matchedRows[0]!.ruleCitation, "matched", "e2e: the row records the citation as matched");
    eq(matchedRows[0]!.verdict, "allow", "e2e: the cited row is the allow");

    clearApprovalJudgeVerdictCache();
    registerApprovalJudgeCompletion(async (_p, pass) =>
      pass === "scrutiny" ? "YES" : "VERDICT: allow\nREASON: routine on its own facts",
    );
    await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 501_000 } }, { postCard });
    const uncited = (await verdictRows()).filter((d) => d.reasoning === "routine on its own facts");
    eq(uncited.length, 1, "e2e: the uncited consult wrote its own row");
    eq(uncited[0]!.ruleId, undefined, "e2e: an allow that matched NO rule carries NO rule id on the row");
    eq(uncited[0]!.ruleCitation, undefined, "e2e: and no citation outcome");

    clearApprovalJudgeVerdictCache();
    registerApprovalJudgeCompletion(async (_p, pass) =>
      pass === "scrutiny" ? "YES" : "VERDICT: allow\nREASON: invented\nRULE: not-a-real-rule",
    );
    const fenced = await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 502_000 } }, { postCard });
    eq(fenced.autoApproved, undefined, "e2e fence: an allow citing a fabricated rule id CARDS instead of executing");
    const fencedRows = (await verdictRows()).filter((d) => d.ruleCitation === "unmatched");
    eq(fencedRows.length, 1, "e2e fence: the unmatched citation is recorded on the row");
    eq(fencedRows[0]!.ruleId, undefined, "e2e fence: no rule id is minted from a fabrication");
    eq(fencedRows[0]!.enforcedVerdict, "ask", "e2e fence: the enforced verdict is the ask");
  } finally {
    overrideSettingsForTest({ approvals: { judgeMode: "off" } });
    resetApprovalJudgeCompletion();
    clearApprovalJudgeVerdictCache();
  }
}

{
  eq(resolvePreApprovalRuleCitation("org-pr", RULES_CTX)?.id, "org-pr", "citation: a known id resolves");
  eq(resolvePreApprovalRuleCitation("nope", RULES_CTX), undefined, "citation: an unknown id does not resolve");
  eq(resolvePreApprovalRuleCitation(undefined, RULES_CTX), undefined, "citation: no citation resolves to nothing");
  eq(resolvePreApprovalRuleCitation("  ", RULES_CTX), undefined, "citation: whitespace resolves to nothing");
  eq(resolvePreApprovalRuleCitation("org-pr", []), undefined, "citation: an id cannot resolve against an empty rule set");
}

{
  for (const id of ["a", "deploy-staging", "pay.refund_2", "A1", "x".repeat(64)]) {
    ok(isValidPreApprovalRuleId(id), `grammar round trip: "${id.slice(0, 12)}…" validates at config load`);
    const parsed = new RegExp(`RULE:\\s*\\[?(${PRE_APPROVAL_RULE_ID_PATTERN})\\]?`, "iu").exec(`RULE: ${id}`);
    eq(parsed?.[1], id, `grammar round trip: "${id.slice(0, 12)}…" parses back out of a citation whole`);
  }
  ok(!isValidPreApprovalRuleId("x".repeat(65)), "grammar: 65 characters is over the id cap");
}

await removeTempDir(tmp);
console.log(`✓ pre-approval rules (OPE-512): ${passed} assertions passed`);
