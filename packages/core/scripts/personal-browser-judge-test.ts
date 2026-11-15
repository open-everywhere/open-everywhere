import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-personal-browser-judge-"));
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "pbj.sqlite3");

import { overrideSettingsForTest } from "../agent/settings/settings.js";
overrideSettingsForTest({ approvals: { judgeMode: "off" } });

const policyMod = await import("../agent/personal-browser/policy.js");
const never = await import("../agent/personal-browser/never-tier.js");
const lifecycle = await import("../agent/personal-browser/lifecycle.js");
const storeMod = await import("../agent/personal-browser/store.js");
const boxClient = await import("../agent/personal-browser/box-client.js");
await import("../agent/approvals/personal-browser.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { judgeDeferredTool, judgeDeferSwitchStateOf } = await import("../agent/access/consequence.js");
const { resolveApproverChain } = await import("../agent/access/approver-chain.js");
const {
  judgeContextOf,
  judgeVerdictPrompt,
  registerApprovalJudgeCompletion,
  resetApprovalJudgeCompletion,
  clearApprovalJudgeVerdictCache,
  runApprovalJudge,
  setApprovalJudgeCacheStoreForTest,
  shadowJudgeAuditDetail,
} = await import("../agent/access/approval-judge.js");
const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { readAudit } = await import("../agent/audit/audit.js");
import type { ApprovalChainRequest } from "../agent/access/approver-chain.js";
import type { Bundle } from "../agent/access/bundle.js";
import type { PersonalBrowserPolicy } from "../agent/personal-browser/policy.js";
import type { BoxTransport } from "../agent/personal-browser/box-client.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejects(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (message mentions "${needle}", got: ${String(err)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const ORG = "acme";
const ON: PersonalBrowserPolicy = { ...policyMod.DEFAULT_PERSONAL_BROWSER_POLICY, enabled: true, box: { image: "oe-personal-browser:1", vcpus: 2, memoryMb: 4096 } };
const withJudge = (judge: "off" | "shadow" | "enforce"): void => policyMod.registerPersonalBrowserPolicy({ ...ON, judge });

const RULE = { id: "browser-shop-click", rule: "In the person's own browser, the agent may click on shop.example.com when the person asked for it.", scope: "org" as const };
const RULES = [RULE];

const STEP_ARGS = { org: ORG, person: "slack/T1/UANA", principalId: "UANA", host: "shop.example.com", minutes: 60, step: { op: "click" } };
const WINDOW_ARGS = { org: ORG, person: "slack/T1/UANA", principalId: "UANA", host: "shop.example.com", minutes: 60 };

function browserReq(extra: Partial<ApprovalChainRequest> = {}): ApprovalChainRequest {
  return { tool: "my_browser", action: "browser.personal.act", args: STEP_ARGS, scopeKey: "slack/T1/D-UANA", org: ORG, principalId: "UANA", unattended: false, tainted: false, ...extra };
}

function allowingJudge(): { calls: string[] } {
  const calls: string[] = [];
  registerApprovalJudgeCompletion(async (prompt, pass) => {
    calls.push(prompt);
    return pass === "scrutiny" ? "YES" : `VERDICT: allow\nREASON: the rule covers a click on this site\nRULE: ${RULE.id}`;
  });
  return { calls };
}

{
  ok(policyMod.DEFAULT_PERSONAL_BROWSER_POLICY.judge === "off", "A: the shipped browser judge switch is OFF");
  ok(policyMod.personalBrowserJudgeMode() === "off", "A: with no registration the switch reads off");
  ok(policyMod.personalBrowserJudgeMode({ ...ON, judge: undefined }) === "off", "A: an absent switch reads off");
  ok(policyMod.personalBrowserPolicyProblems({ ...ON, judge: "on" as never }).length > 0, "A: a mis-spelled switch value is a problem");
  ok(policyMod.personalBrowserPolicyProblems({ ...ON, judge: "shadow" }).length === 0, "A: shadow is a valid switch value");
  ok(policyMod.personalBrowserPolicyProblems({ ...ON, neverHosts: ["https://bank.example"] }).length > 0, "C: a neverHosts entry with a scheme is a problem");
  ok(policyMod.personalBrowserPolicyProblems({ ...ON, neverHosts: ["vault.example.org"] }).length === 0, "C: a plain host is a valid neverHosts entry");

  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  policyMod.registerPersonalBrowserPolicy(ON);
  const stub = allowingJudge();
  clearApprovalJudgeVerdictCache();
  ok(judgeDeferSwitchStateOf("my_browser") === "off" && judgeDeferredTool("my_browser") === false, "🔴 A: with the switch off, my_browser is NOT defer-flipped, even on an armed deployment");
  const offRes = await resolveApproverChain(browserReq(), { rules: RULES, judge: true });
  ok(offRes.verdict === "ask" && offRes.judge === undefined && stub.calls.length === 0, "🔴 A: switch off ⇒ the step cards and the judge is never called, rules or not");
  ok((await shadowJudgeAuditDetail(browserReq(), offRes, undefined, RULES)) === undefined && stub.calls.length === 0, "A: switch off ⇒ no browser shadow row either (global mode enforce)");

  withJudge("enforce");
  ok(judgeDeferredTool("my_browser") === true, "A (control): the switch at enforce defer-flips my_browser");
  const onRes = await resolveApproverChain(browserReq(), { rules: RULES, judge: true });
  ok(onRes.verdict === "allow" && onRes.resolvedBy === "judge" && onRes.judge?.ruleId === RULE.id && stub.calls.length > 0, "A (control): switch enforce ⇒ the judge lifts the step under the cited rule");

  overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  stub.calls.length = 0;
  const globalOff = await resolveApproverChain(browserReq(), { rules: RULES, judge: true });
  ok(globalOff.verdict === "ask" && globalOff.judge === undefined && stub.calls.length === 0, "A: approvals.judgeMode off ⇒ no consult, whatever the browser switch says");
  withJudge("shadow");
  ok((await shadowJudgeAuditDetail(browserReq(), globalOff, undefined, RULES)) === undefined && stub.calls.length === 0, "A: approvals.judgeMode off ⇒ no browser shadow either");

  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  clearApprovalJudgeVerdictCache();
  ok(judgeDeferredTool("my_browser") === false, "A: at shadow my_browser is NOT defer-flipped");
  const shadowRes = await resolveApproverChain(browserReq(), { rules: RULES, judge: true });
  ok(shadowRes.verdict === "ask" && shadowRes.judge === undefined, "A: at shadow the step still cards");
  const detail = (await shadowJudgeAuditDetail(browserReq(), shadowRes, undefined, RULES)) as Record<string, unknown> | undefined;
  ok(detail !== undefined && detail["mode"] === "shadow" && detail["switch"] === "personal-browser.judge", "A: at shadow a shadow detail names the switch, on an enforce deployment");
  ok(detail?.["wouldVerdict"] === "allow" && detail?.["ruleId"] === RULE.id && detail?.["enforcedVerdict"] === "ask", "A: the shadow row records the would-be allow and the rule it cited, beside the enforced ask");
  registerApprovalJudgeCompletion(async (_p, pass) => (pass === "scrutiny" ? "NO" : "VERDICT: allow\nREASON: looks routine"));
  clearApprovalJudgeVerdictCache();
  const uncited = (await shadowJudgeAuditDetail(browserReq(), shadowRes, undefined, RULES)) as Record<string, unknown> | undefined;
  ok(uncited?.["wouldVerdict"] === "ask" && uncited?.["ruleCitation"] === "uncited", "A: a shadow allow that cites no rule is recorded as the ask enforce would give");
  resetApprovalJudgeCompletion();
}

{
  const store = new Map<string, unknown>();
  setApprovalJudgeCacheStoreForTest({ get: (k) => store.get(k) as never, set: (k, e) => void store.set(k, e), delete: (k) => void store.delete(k) });
  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  let verdictCalls = 0;
  registerApprovalJudgeCompletion(async (_p, pass) => {
    if (pass !== "scrutiny") verdictCalls++;
    return pass === "scrutiny" ? "YES" : `VERDICT: allow\nREASON: the rule covers a click on this site\nRULE: ${RULE.id}`;
  });
  clearApprovalJudgeVerdictCache();

  const prCtx = judgeContextOf({ tool: "open_pull_request", action: "pr.open", unattended: false, tainted: false, principalId: "UANA", scopeKey: "slack/T1/D-UANA" }, { registryVerdict: "ask" }, RULES);
  const prRun = await runApprovalJudge(prCtx, { enforce: true });
  ok(prRun.verdict === "allow" && store.size === 1, "A (control): the test store is live — a cacheable row's enforced allow is cached in it");
  store.clear();
  verdictCalls = 0;

  withJudge("shadow");
  const shadowFirst = await resolveApproverChain(browserReq(), { rules: RULES, judge: true });
  await shadowJudgeAuditDetail(browserReq(), shadowFirst, undefined, RULES);
  ok(verdictCalls === 1 && store.size === 0, "🔴 A: a browser shadow consult writes NO cache entry that enforce could read");

  withJudge("enforce");
  verdictCalls = 0;
  const first = await resolveApproverChain(browserReq(), { rules: RULES, judge: true });
  const second = await resolveApproverChain(browserReq(), { rules: RULES, judge: true });
  ok(first.verdict === "allow" && second.verdict === "allow", "A: two identical browser steps are each allowed under the rule");
  ok(verdictCalls === 2, `🔴 A: two IDENTICAL enforce consults call the judge twice — no cached allow replays a step (got ${verdictCalls})`);
  ok(second.judge?.source !== "cache" && store.size === 0, "🔴 A: …the second consult is not a cache hit, and the store holds no browser entry");

  setApprovalJudgeCacheStoreForTest(undefined);
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
  overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  policyMod.registerPersonalBrowserPolicy(ON);
}

{
  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  withJudge("enforce");
  const stub = allowingJudge();
  clearApprovalJudgeVerdictCache();
  const tainted = await resolveApproverChain(browserReq({ tainted: true }), { rules: RULES, judge: true });
  ok(tainted.verdict === "allow" && tainted.resolvedBy === "judge" && tainted.judge?.ruleId === RULE.id, "🔴 B: a TAINTED browser step reaches the judge and is lifted under the cited rule");
  ok(tainted.transforms.length === 0, "B: no taint arrow moved the browser step");
  const ctx = judgeContextOf(browserReq({ tainted: true }), { registryVerdict: "ask" }, RULES);
  ok(!("tainted" in ctx) && !("taintKinds" in ctx) && !("taintBlind" in ctx), "B: the judge's context for a browser step carries no taint field");
  ok(!/untrusted content/i.test(judgeVerdictPrompt(ctx)), "B: the judge's prompt carries no taint line");
  const other = judgeContextOf({ tool: "open_pull_request", action: "pr.open", unattended: false, tainted: true, principalId: "UANA" }, { registryVerdict: "ask" }, RULES);
  ok(!("tainted" in other) && !/untrusted content/i.test(judgeVerdictPrompt(other)), "B: no other row's context or prompt carries taint either");

  stub.calls.length = 0;
  const windowRes = await resolveApproverChain(browserReq({ args: WINDOW_ARGS }), { rules: RULES, judge: true });
  ok(windowRes.verdict === "ask" && windowRes.judge?.source === "human-only" && stub.calls.length === 0, "🔴 B: a window card with no frozen step is human-only — the judge is never called");
  registerApprovalJudgeCompletion(async (_p, pass) => (pass === "scrutiny" ? "YES" : "VERDICT: ask\nREASON: not covered"));
  clearApprovalJudgeVerdictCache();
  const unattendedAsk = await resolveApproverChain(browserReq({ unattended: true, principalId: undefined }), { rules: RULES, judge: true });
  ok(unattendedAsk.verdict === "deny" && unattendedAsk.transforms.some((t) => t.name === "unattended"), "B: a judge ask on an unattended step is still denied by the unattended arrow");
  resetApprovalJudgeCompletion();

  const actKind = actionKind("browser.personal.act")!;
  const auditBefore = (await readAudit({ org: ORG, limit: 1000 } as never)).filter((r) => r.action === "browser.personal.act_granted").length;
  const outcome = await actKind.execute(STEP_ARGS as never, "chain:judge");
  ok(/allowed one step/.test(String(outcome)) && /No act window was granted/.test(String(outcome)), "B: a judge allow on a step card runs one step and says no window was granted");
  ok((await readAudit({ org: ORG, limit: 1000 } as never)).filter((r) => r.action === "browser.personal.act_granted").length === auditBefore, "🔴 B: …and no act window was recorded");
  await rejects(() => actKind.execute(WINDOW_ARGS as never, "chain:judge"), "only the person whose browser this is", "🔴 B: a judge allow on a WINDOW card (no step) throws");
  await rejects(() => actKind.execute(STEP_ARGS as never, "chain:custom:org-policy"), "only the person whose browser this is", "🔴 B: any other chain lowering, step or not, throws");
}

{
  registerConfig({
    loadBundles: () => [{ name: "org-policy", preApprovalRules: [{ id: RULE.id, rule: RULE.rule }] }] as unknown as readonly Bundle[],
    loadBindings: () => [{ bundle: "org-policy", scope: { level: "org" } }] as never,
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  const postCard = async (): Promise<string> => `ts-${Math.random().toString(36).slice(2)}`;
  const input = () => ({
    org: ORG,
    kind: "browser.personal.act",
    args: STEP_ARGS,
    scopeKey: "slack/T1/D-UANA",
    domain: null,
    requestedBy: "UANA",
    channelId: "D-UANA",
    threadTs: null,
    chain: { unattended: false, tainted: true },
  });

  withJudge("enforce");
  allowingJudge();
  clearApprovalJudgeVerdictCache();
  const lifted = await requestApproval(input(), { postCard });
  ok(lifted.autoApproved?.resolvedBy === "judge" && /allowed one step/.test(String(lifted.autoApproved?.outcome)), "🔴 A+B e2e: switch enforce ⇒ a tainted browser step is lifted by the judge through the real propose plane, with no card");
  const verdictRows = (await readAudit({ org: ORG, limit: 1000 } as never)).filter((r) => r.action === "approval.judge.verdict").map((r) => (r.detail ?? {}) as Record<string, unknown>);
  ok(verdictRows.some((d) => d["tool"] === "my_browser" && d["ruleId"] === RULE.id && d["verdict"] === "allow"), "A+B e2e: the verdict row cites the config-declared rule");

  withJudge("shadow");
  clearApprovalJudgeVerdictCache();
  const carded = await requestApproval(input(), { postCard });
  ok(carded.autoApproved === undefined, "A e2e: at shadow the same step posts its card");
  let shadowRow: Record<string, unknown> | undefined;
  for (let i = 0; i < 50 && shadowRow === undefined; i++) {
    shadowRow = (await readAudit({ org: ORG, limit: 1000 } as never))
      .filter((r) => r.action === "approval.judge.shadow")
      .map((r) => (r.detail ?? {}) as Record<string, unknown>)
      .find((d) => d["tool"] === "my_browser");
    if (shadowRow === undefined) await new Promise((r) => setTimeout(r, 20));
  }
  ok(shadowRow !== undefined && shadowRow["switch"] === "personal-browser.judge" && shadowRow["ruleId"] === RULE.id && !("tainted" in shadowRow), "A e2e: …and the propose plane writes ONE shadow row that names the switch and cites the config rule, with no taint field (OPE-2716)");
  resetApprovalJudgeCompletion();
  overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  policyMod.registerPersonalBrowserPolicy(ON);
}

{
  const m = (h: string, p?: PersonalBrowserPolicy) => never.browserNeverHostMatch(h, p ?? ON);
  ok(m("www.paypal.com")?.source === "default" && (m("www.paypal.com") as { category: string }).category === "payments", "C: a shipped payment domain matches, subdomains included");
  ok((m("secure.chase.com") as { category?: string } | undefined)?.category === "banking", "C: a shipped bank matches");
  ok((m("robinhood.com") as { category?: string } | undefined)?.category === "trading", "C: a shipped broker matches");
  ok((m("onlinebanking.example.co.uk") as { rule?: string } | undefined)?.rule === "label:bank", "C: a host label holding 'bank' matches");
  ok((m("pay.amazon.com") as { rule?: string } | undefined)?.rule === "label:pay", "C: a 'pay' label matches");
  ok((m("checkout.shop.example") as { rule?: string } | undefined)?.rule === "label:checkout", "C: a 'checkout' label matches");
  ok((m("my-trading.example.com") as { rule?: string } | undefined)?.rule === "label:trading", "C: a hyphen part of a label matches");
  ok(m("mail.example.com") === undefined && m("shop.example.com") === undefined && m("payroll-news.example") === undefined, "C (control): an ordinary site, and a label that only starts like a word, do not match");
  const withHosts = { ...ON, neverHosts: ["vault.example.org"] };
  ok(m("app.vault.example.org", withHosts)?.source === "policy" && m("app.vault.example.org") === undefined, "C: the policy's neverHosts ADDS a host, subdomains included");
  ok(m("notvault.example.org", withHosts) === undefined, "C (control): neverHosts matches whole labels, not a suffix of one");
  ok(/no approval, rule or setting can allow it/.test(never.browserNeverRefusalMessage("www.paypal.com", m("www.paypal.com")!)), "C: the refusal says no approval can allow it");

  const cmds: string[] = [];
  let page = "https://www.paypal.com/myaccount";
  const transport: BoxTransport = async (req) => {
    const path = new URL(req.url).pathname;
    cmds.push(path);
    if (path === "/health") return { status: 200, json: { ok: true, url: page } };
    return { status: 200, json: { ok: true, url: page } };
  };
  boxClient.setBoxTransportForTest(transport);
  const person = "slack/T1/UNEV";
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: "D-UNEV", workspaceKey: "slack/T1", surfaceKey: "slack/T1/D-UNEV", key: "slack/T1/D-UNEV" };
  const box = { name: "box-never", backend: "vercel", metered: true, url: "https://box-never.example", key: "k".repeat(64), createdAt: Date.now(), maxMinutes: 60, memoryMb: 4096, egressEnforced: true };
  const future = Date.now() + 3_600_000;
  await storeMod.updatePersonalBrowser(ORG, person, () => ({
    next: { v: 1, org: ORG, person, principalId: "UNEV", platform: "slack", dm: { channelId: "D-UNEV" }, partition, persistKey: lifecycle.persistKeyFor(ORG, person), lock: { holder: "agent", since: Date.now() }, acts: { "www.paypal.com": future, "shop.example.com": future }, links: {}, sessions: {}, box } as never,
    result: undefined,
  }));
  const state = (await storeMod.getPersonalBrowserState(ORG, person))!.state;
  const live = { ...state, box: state.box! };
  const refused = await lifecycle.actOnBrowser(live, "click", { ref: "e1" }, { policy: ON });
  ok(refused.kind === "refused" && refused.neverTier === true && /never click or type on www\.paypal\.com/.test(refused.message), "🔴 C: a click on a never-tier host is refused even with a live act window");
  ok(!cmds.includes("/cmd"), "🔴 C: …and nothing reached the box");
  const judged = await lifecycle.actOnBrowser(live, "type", { ref: "e1", text: "x" }, { policy: ON }, { host: "www.paypal.com", pendingId: "p1" });
  ok(judged.kind === "refused" && judged.neverTier === true && !cmds.includes("/cmd"), "🔴 C: a judge-allowed step on a never-tier host is refused too");
  const rows = (await readAudit({ org: ORG, limit: 1000 } as never)).filter((r) => r.action === "browser.personal.action").map((r) => (r.detail ?? {}) as Record<string, unknown>);
  ok(rows.filter((d) => d["refused"] === "never_tier" && d["host"] === "www.paypal.com").length === 2, "C: each never-tier refusal writes one browser.personal.action row with refused: never_tier");
  ok(!JSON.stringify(rows).includes('"x"'), "C: the refusal row never carries the typed text");
  page = "https://shop.example.com/cart";
  const done = await lifecycle.actOnBrowser(live, "click", { ref: "e1" }, { policy: ON });
  ok(done.kind === "done" && cmds.includes("/cmd"), "C (control): the same window on an ordinary site reaches the box");

  const noWindow = { ...live, acts: {} };
  cmds.length = 0;
  const oldBox = await lifecycle.actOnBrowser(noWindow, "click", { ref: "e1" }, { policy: ON }, { host: "shop.example.com", pendingId: "p-old" });
  ok(oldBox.kind === "refused" && oldBox.message === never.BOX_CAPABILITY_REFUSAL, "🔴 C: a judged step on a box that does not report payment-submit-refusal is refused");
  ok(!cmds.includes("/cmd"), "🔴 C: …and nothing reached the box");
  const capRows = (await readAudit({ org: ORG, limit: 1000 } as never)).filter((r) => r.action === "browser.personal.action").map((r) => (r.detail ?? {}) as Record<string, unknown>);
  ok(capRows.some((d) => d["refused"] === "box_capability" && d["pendingId"] === "p-old"), "C: the refusal writes a browser.personal.action row with refused: box_capability");
  const reporting: BoxTransport = async (req) => {
    const path = new URL(req.url).pathname;
    cmds.push(path);
    return { status: 200, json: { ok: true, url: page, ...(path === "/health" ? { capabilities: [never.BOX_PAYMENT_SUBMIT_CAPABILITY] } : {}) } };
  };
  boxClient.setBoxTransportForTest(reporting);
  const newBox = await lifecycle.actOnBrowser(noWindow, "click", { ref: "e1" }, { policy: ON }, { host: "shop.example.com", pendingId: "p-new" });
  ok(newBox.kind === "done" && cmds.includes("/cmd"), "C (control): the same judged step on a box that reports the capability runs");
  ok(never.boxRefusesPaymentSubmit({ capabilities: ["payment-submit-refusal"] }) && !never.boxRefusesPaymentSubmit({ ok: true }) && !never.boxRefusesPaymentSubmit(undefined), "C: the capability read is exact, and absent reads as missing");
  boxClient.setBoxTransportForTest(transport);

  await rejects(() => lifecycle.grantAct(ORG, person, "www.paypal.com", 60, "UNEV", { policy: ON }), "never click or type", "🔴 C: grantAct refuses a never-tier host");
  const actKind = actionKind("browser.personal.act")!;
  await rejects(() => actKind.execute({ ...WINDOW_ARGS, person, principalId: "UNEV", host: "www.paypal.com" } as never, "UNEV"), "never click or type", "🔴 C: the owner's own click on a never-tier act card grants nothing");
  await rejects(() => actKind.execute({ ...STEP_ARGS, person, principalId: "UNEV", host: "pay.example.com" } as never, "chain:judge"), "never click or type", "🔴 C: a judge allow on a never-tier step grants nothing");
}

console.log(`✓ personal-browser-judge (OPE-2672): ${passed} assertions passed`);
