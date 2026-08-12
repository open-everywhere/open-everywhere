import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-approval-judge-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_ORG;
overrideSettingsForTest({ approvals: { judgeMode: "off" } });

const {
  approvalJudgeMode,
  approvalJudgeBreakerTripped,
  clearApprovalJudgeVerdictCache,
  judgeContextOf,
  judgeExemption,
  judgeScrutinyPrompt,
  judgeVerdictCacheKey,
  judgeVerdictPrompt,
  recordApprovalJudgeContradiction,
  registerApprovalJudgeCompletion,
  resetApprovalJudgeCompletion,
  runApprovalJudge,
  setApprovalJudgeCacheStoreForTest,
  shadowJudgeAuditDetail,
  shadowJudgeEligible,
  APPROVAL_JUDGE_BREAKER_THRESHOLD,
} = await import("../agent/access/approval-judge.js");
const { resolveApproverChain, toolForActionKind } = await import("../agent/access/approver-chain.js");
const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");

import type { ApprovalChainRequest } from "../agent/access/approver-chain.js";
import type { ApprovalJudgeContext, JudgeCacheEntry } from "../agent/access/approval-judge.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

function req(tool: string, extra: Partial<ApprovalChainRequest> = {}): ApprovalChainRequest {
  return { tool, unattended: false, tainted: false, principalId: "U1", ...extra };
}

function ctxOf(tool: string, extra: Partial<ApprovalJudgeContext> = {}): ApprovalJudgeContext {
  return { tool, argsJson: "{}", registryVerdict: "ask", unattended: false, tainted: false, taintKinds: [], ...extra };
}

function stubJudge(answers: { scrutiny?: string; verdict?: string; throws?: boolean }): { calls: { pass: string; prompt: string }[] } {
  const calls: { pass: string; prompt: string }[] = [];
  registerApprovalJudgeCompletion(async (prompt, pass) => {
    calls.push({ pass, prompt });
    if (answers.throws === true) throw new Error("stub transport down");
    return (pass === "scrutiny" ? answers.scrutiny : answers.verdict) ?? "";
  });
  return { calls };
}

ok(approvalJudgeMode() === "off", "arming: unset env ⇒ off (code default)");
overrideSettingsForTest({ approvals: { judgeMode: "shadow" } });
ok(approvalJudgeMode() === "shadow", "arming: OE_APPROVAL_JUDGE=shadow arms shadow mode");
overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
ok(approvalJudgeMode() === "enforce", "arming: OE_APPROVAL_JUDGE=enforce arms ENFORCEMENT (phase 2)");
overrideSettingsForTest({ approvals: { judgeMode: "off" } });
ok(approvalJudgeMode() === "off", "arming: a case variant fails CLOSED to off (never a surprise arm)");
overrideSettingsForTest({ approvals: { judgeMode: "off" } });
ok(approvalJudgeMode() === "off", "arming: an unknown value fails CLOSED to off");
overrideSettingsForTest({ approvals: { judgeMode: "off" } });
ok(approvalJudgeMode() === "off", "arming: a typo fails closed to off");
overrideSettingsForTest({ approvals: { judgeMode: "off" } });

{
  const stub = stubJudge({ scrutiny: "YES", verdict: "VERDICT: deny\nREASON: stub" });
  const res = await resolveApproverChain(req("create_ticket"));
  ok(res.verdict === "ask" && res.resolvedBy === "registry", "off: the chain resolves ask exactly as today");
  const detail = await shadowJudgeAuditDetail(req("create_ticket"), res);
  ok(detail === undefined, "off: the shadow seam returns undefined with the judge off");
  ok(stub.calls.length === 0, "off: a registered transport is NEVER called with the judge off");
  resetApprovalJudgeCompletion();
}

overrideSettingsForTest({ approvals: { judgeMode: "shadow" } });
{
  const registryAsk = await resolveApproverChain(req("create_ticket"));
  ok(shadowJudgeEligible(registryAsk), "eligible: a registry-terminal ask is the flip-candidate shape");
  const classifierAsk = await resolveApproverChain(req("notion__create_page"));
  ok(shadowJudgeEligible(classifierAsk), "eligible: a verb-classifier ask (connector write) is too");

  const open = await resolveApproverChain(req("reply"));
  ok(!shadowJudgeEligible(open), "ineligible: an allow (no card) never reaches the judge");
  const denied = await resolveApproverChain(req("create_ticket", { mode: { mode: "DENY_ALL" } }));
  ok(!shadowJudgeEligible(denied), "ineligible: a deny is absolute — never judge material");
  const pinned = await resolveApproverChain(req("create_ticket"), { approvers: [{ name: "pin", approve: () => "ask" }] });
  ok(pinned.verdict === "ask" && !shadowJudgeEligible(pinned), "ineligible: an OPERATOR ask is pinned policy the judge must not touch");
  const floored = await resolveApproverChain(req("read_channel", { mode: { mode: "APPROVE_ALL" } }));
  ok(floored.verdict === "ask" && !shadowJudgeEligible(floored), "ineligible: a mode-floored ask is mode policy, not a flippable row");
}

{
  ok(judgeExemption("reply").exempt && judgeExemption("reply").reason === "own-open-row", "exempt: an OE tool's OPEN row is sure-readonly");
  ok(!judgeExemption("create_ticket").exempt, "not exempt: a GATED own row is the flip-candidate population");
  ok(!judgeExemption("no_such_tool").exempt, "not exempt: an unknown name is never exempt (fail-closed)");

  const readonlyOk = judgeExemption("notion__search", { orgAdmitted: true, readOnlyHint: true });
  ok(readonlyOk.exempt && readonlyOk.reason === "vendor-readonly", "exempt: org-admitted + readOnlyHint + agreeing read name");
  const contradicted = judgeExemption("notion__delete_page", { orgAdmitted: true, readOnlyHint: true });
  ok(!contradicted.exempt && contradicted.reason === "hint-contradicted", "not exempt: hint says readonly, NAME says destructive — defer, never open");
  const writeName = judgeExemption("notion__create_page", { orgAdmitted: true, readOnlyHint: true });
  ok(!writeName.exempt && writeName.reason === "hint-contradicted", "not exempt: a write token contradicts the hint too");
  ok(!judgeExemption("notion__search", { readOnlyHint: true }).exempt, "not exempt: a hint WITHOUT org admission is untrusted");
  ok(!judgeExemption("notion__search", { orgAdmitted: true }).exempt, "not exempt: org admission WITHOUT a hint attests nothing");
  ok(!judgeExemption("notion__search").exempt, "not exempt: a bare connector op carries no attestation");
}

{
  clearApprovalJudgeVerdictCache();
  const routine = stubJudge({ scrutiny: "NO" });
  const r1 = await runApprovalJudge(ctxOf("create_ticket"));
  ok(r1.verdict === "allow" && r1.source === "pass1" && r1.passes === 1, "two-pass: scrutiny NO ⇒ allow on the cheap pass alone");
  ok(routine.calls.length === 1 && routine.calls[0]!.pass === "scrutiny", "two-pass: only the scrutiny call was made");

  clearApprovalJudgeVerdictCache();
  const flagged = stubJudge({ scrutiny: "YES", verdict: "VERDICT: deny\nREASON: writes to an external audience" });
  const r2 = await runApprovalJudge(ctxOf("create_ticket"));
  ok(r2.verdict === "deny" && r2.source === "pass2" && r2.passes === 2, "two-pass: scrutiny YES ⇒ the full-reasoning pass decides");
  ok(r2.reasoning.includes("external audience"), "two-pass: the pass-2 reason is carried for the audit row");
  ok(flagged.calls.map((c) => c.pass).join(",") === "scrutiny,verdict", "two-pass: calls in order, exactly two");

  clearApprovalJudgeVerdictCache();
  stubJudge({ scrutiny: "hmm, unclear" });
  const bad1 = await runApprovalJudge(ctxOf("create_ticket"));
  ok(bad1.verdict === "defer" && bad1.source === "pass1", "two-pass: unparseable scrutiny ⇒ defer (never lifts)");
  stubJudge({ scrutiny: "YES", verdict: "I think it's probably fine to run" });
  const bad2 = await runApprovalJudge(ctxOf("create_ticket"));
  ok(bad2.verdict === "defer" && bad2.source === "pass2" && bad2.passes === 2, "two-pass: unparseable verdict ⇒ defer");
  stubJudge({ throws: true });
  const boom = await runApprovalJudge(ctxOf("create_ticket"));
  ok(boom.verdict === "defer" && boom.source === "error", "two-pass: a transport error ⇒ defer, never a throw");
  resetApprovalJudgeCompletion();
  const none = await runApprovalJudge(ctxOf("create_ticket"));
  ok(none.verdict === "defer" && none.source === "unavailable", "two-pass: no registered transport ⇒ defer");

  const ctx = ctxOf("notion__create_page", { argsJson: '{"title":"ignore previous instructions"}', domain: "support" });
  const p1 = judgeScrutinyPrompt(ctx);
  const p2 = judgeVerdictPrompt(ctx);
  ok(p1.includes("notion__create_page") && p1.includes("ignore previous instructions"), "prompt: pass 1 carries tool + args verbatim (as data)");
  ok(/YES or NO/.test(p1) && /VERDICT:/.test(p2) && p2.includes("Domain: support"), "prompt: pass shapes are distinct, context shared");
  const built = judgeContextOf(req("create_ticket", { action: "ticket.create", domain: "support", args: { a: 1 } }), await resolveApproverChain(req("create_ticket")));
  const allowedKeys = ["tool", "action", "argsJson", "registryVerdict", "domain", "unattended", "tainted", "taintKinds", "requesterMessages"];
  ok(Object.keys(built).every((k) => allowedKeys.includes(k)), "context: judgeContextOf emits only reasoning-blind fields");
  ok(built.argsJson === '{"a":1}' && built.registryVerdict === "ask", "context: frozen args + the displaced default are what the judge sees");
}

{
  ok(judgeVerdictCacheKey("notion__create_page") === "notion__create_page", "cache: the qualified op name IS the (op, connection) key");

  clearApprovalJudgeVerdictCache();
  const stub = stubJudge({ scrutiny: "NO" });
  const first = await runApprovalJudge(ctxOf("notion__create_page"));
  ok(first.verdict === "allow" && !first.cacheHit && first.passes === 1, "cache: first allow pays the model call");
  const second = await runApprovalJudge(ctxOf("notion__create_page"));
  ok(second.verdict === "allow" && second.cacheHit && second.source === "cache" && second.passes === 0, "cache: same (op, connection) reuses the allow, zero calls");
  ok(stub.calls.length === 1, "cache: the transport really was consulted once");
  const other = await runApprovalJudge(ctxOf("linear__create_issue"));
  ok(!other.cacheHit, "cache: a different connection/op never hits another key's entry");

  const tainted = await runApprovalJudge(ctxOf("notion__create_page", { tainted: true, taintKinds: ["webhook"] }));
  ok(!tainted.cacheHit, "cache: taint arriving invalidates the clean-turn allow");
  ok(stub.calls.length === 3, "cache: …by consulting the transport again");
  const moreTaint = await runApprovalJudge(ctxOf("notion__create_page", { tainted: true, taintKinds: ["webhook", "web_fetch"] }));
  ok(!moreTaint.cacheHit, "cache: NEW untrusted content (kind list grew) invalidates the tainted allow too");
  const stable = await runApprovalJudge(ctxOf("notion__create_page", { tainted: true, taintKinds: ["webhook", "web_fetch"] }));
  ok(stable.cacheHit, "cache: an unchanged taint signature reuses the re-rendered allow");

  clearApprovalJudgeVerdictCache();
  const denyStub = stubJudge({ scrutiny: "YES", verdict: "VERDICT: deny\nREASON: no" });
  await runApprovalJudge(ctxOf("create_ticket"));
  const denyAgain = await runApprovalJudge(ctxOf("create_ticket"));
  ok(!denyAgain.cacheHit && denyStub.calls.length === 4, "cache: a deny is NEVER cached — both runs consulted the transport");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "plain", channels: ["slack/T1/C_PLAIN"] }],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
const postCard = async (): Promise<string> => `ts-${Math.random().toString(36).slice(2)}`;
const baseInput = {
  org: "test-org",
  kind: "skill.delete",
  channelId: "C_PLAIN",
  requestedBy: "U_HUMAN",
  threadTs: null,
  scopeKey: "slack/T1/C_PLAIN",
  domain: "plain",
  args: { org: "test-org", domain: "plain", name: "ghost-skill", requestedBy: "U_HUMAN" },
};
async function shadowRows(expectAtLeast = 1): Promise<{ detail?: Record<string, unknown> }[]> {
  for (let i = 0; i < 50; i++) {
    const rows = (await readAudit({})).filter((r) => r.action === "approval.judge.shadow") as {
      detail?: Record<string, unknown>;
    }[];
    if (rows.length >= expectAtLeast) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await readAudit({})).filter((r) => r.action === "approval.judge.shadow") as { detail?: Record<string, unknown> }[];
}

{
  stubJudge({ scrutiny: "YES", verdict: "VERDICT: allow\nREASON: routine internal cleanup" });
  const res = await requestApproval(baseInput, { postCard });
  ok(res.autoApproved === undefined && typeof res.id === "string", "shadow: the propose still CARDS — no verdict was applied");
  const row = (await getOperationalStore().listPendingActions("test-org")).find((r) => r.id === res.id);
  ok(row !== undefined && row.status === "pending", "shadow: the pending row awaits a human click, exactly as today");
  const rows = await shadowRows();
  ok(rows.length === 1, "shadow: exactly one approval.judge.shadow row was written");
  const d = rows[0]!.detail ?? {};
  const chainTool = toolForActionKind("skill.delete");
  ok(d.tool === chainTool && d.mode === "shadow", "shadow: the row names the op and the mode");
  ok(d.wouldVerdict === "allow" && d.enforcedVerdict === "ask", "shadow: would-be verdict logged BESIDE the enforced one");
  ok(d.resolvedBy === "registry" && d.registryVerdict === "ask", "shadow: the displaced default and its element are on the row");
  ok(typeof d.reasoning === "string" && (d.reasoning as string).includes("routine internal cleanup"), "shadow: a reasoning summary is on the row");
  ok(d.cacheKey === chainTool && d.cacheHit === false && d.passes === 2, "shadow: the (op, connection) cache key + pass count are on the row");

  await requestApproval(baseInput, { postCard });
  const rows2 = await shadowRows(2);
  ok(rows2.length === 2 && rows2[0]!.detail?.cacheHit === true && rows2[0]!.detail?.passes === 0, "shadow: a repeat propose logs a CACHE HIT (machinery proven for phase 2)");

  overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  const off = await requestApproval(baseInput, { postCard });
  ok(off.autoApproved === undefined, "off: the card path is byte-identical with the judge off");
  ok((await shadowRows()).length === 2, "off: NO shadow row is written with the judge off");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

{
  clearApprovalJudgeVerdictCache();
  const contradicts = stubJudge({ scrutiny: "NO", verdict: "VERDICT: ask\nREASON: needs a human" });
  const r = await runApprovalJudge(ctxOf("open_pull_request"), { enforce: true });
  ok(r.verdict === "ask" && r.source === "pass2" && r.passes === 2, "enforce: a pass-1 would-allow NEVER enforces — pass 2 ran and its ask decided");
  ok(r.pass1 === "no", "enforce: the pass-1 answer is still recorded (the comparative track record keeps accruing)");
  ok(contradicts.calls.map((c) => c.pass).join(",") === "scrutiny,verdict", "enforce: both passes ran, in order");

  clearApprovalJudgeVerdictCache();
  stubJudge({ scrutiny: "hmm", verdict: "VERDICT: allow\nREASON: routine internal read" });
  const r2 = await runApprovalJudge(ctxOf("open_pull_request"), { enforce: true });
  ok(r2.verdict === "allow" && r2.source === "pass2" && r2.pass1 === "unparseable", "enforce: an unparseable pass 1 does not defer — pass 2 decides (only pass-2 verdicts enforce)");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

{
  clearApprovalJudgeVerdictCache();
  const uncached = stubJudge({ scrutiny: "YES", verdict: "VERDICT: allow\nREASON: fine" });
  await runApprovalJudge(ctxOf("open_pull_request"), { enforce: true });
  const again = await runApprovalJudge(ctxOf("open_pull_request"), { enforce: true });
  ok(!again.cacheHit && uncached.calls.length === 4, "enforce: with no session slot there is NO cache — an enforced allow never rides a per-process store (both runs paid both passes)");

  const entries = new Map<string, JudgeCacheEntry>();
  setApprovalJudgeCacheStoreForTest({
    get: (k) => entries.get(k),
    set: (k, e) => void entries.set(k, e),
    delete: (k) => void entries.delete(k),
  });
  const cachedStub = stubJudge({ scrutiny: "YES", verdict: "VERDICT: allow\nREASON: fine" });
  const first = await runApprovalJudge(ctxOf("open_pull_request"), { enforce: true });
  ok(first.verdict === "allow" && !first.cacheHit && first.passes === 2, "enforce: a session-scoped store caches the pass-2 allow");
  const hit = await runApprovalJudge(ctxOf("open_pull_request"), { enforce: true });
  ok(hit.cacheHit && hit.source === "cache" && hit.passes === 0 && cachedStub.calls.length === 2, "enforce: the second run is a zero-call cache hit");

  entries.clear();
  const shadowStub = stubJudge({ scrutiny: "NO", verdict: "VERDICT: ask\nREASON: needs a human" });
  const shadowRun = await runApprovalJudge(ctxOf("create_routine"));
  ok(shadowRun.verdict === "allow" && shadowRun.source === "pass1", "enforce-cache setup: a shadow pass-1 allow landed in the shared session store");
  const enforceAfterShadow = await runApprovalJudge(ctxOf("create_routine"), { enforce: true });
  ok(!enforceAfterShadow.cacheHit && enforceAfterShadow.verdict === "ask", "enforce: a pass-1-sourced cache entry NEVER enforces — the run re-judged and pass 2 decided");
  ok(shadowStub.calls.length === 3, "enforce: …by really consulting the transport again (1 shadow + 2 enforce calls)");
  setApprovalJudgeCacheStoreForTest(undefined);
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

{
  clearApprovalJudgeVerdictCache();
  const entries = new Map<string, JudgeCacheEntry>();
  setApprovalJudgeCacheStoreForTest({
    get: (k) => entries.get(k),
    set: (k, e) => void entries.set(k, e),
    delete: (k) => void entries.delete(k),
  });
  let releaseScrutiny: ((text: string) => void) | undefined;
  registerApprovalJudgeCompletion(
    (_prompt, pass) =>
      pass === "scrutiny"
        ? new Promise<string>((resolve) => {
            releaseScrutiny = resolve;
          })
        : Promise.resolve("VERDICT: allow\nREASON: late"),
  );
  const timed = await runApprovalJudge(ctxOf("purge_memory"), { enforce: true, timeoutMs: 40 });
  ok(timed.verdict === "defer" && timed.source === "timeout", "timeout: a hung transport defers (⇒ the last-resort ask) instead of wedging the turn");
  releaseScrutiny?.("YES");
  await new Promise((r) => setTimeout(r, 20));
  ok(entries.size === 0, "timeout: the late-resolving verdict did NOT back-fill the cache");
  setApprovalJudgeCacheStoreForTest(undefined);
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
const spendInput = {
  org: "test-org",
  kind: "spend.set",
  channelId: "C_PLAIN",
  requestedBy: "U_HUMAN",
  threadTs: null,
  scopeKey: "slack/T1/C_PLAIN",
  domain: "plain",
  args: { org: "test-org", scopeKey: "slack/T1/C_PLAIN", level: "surface", monthlyTokens: 500_000, currentCap: null },
};

async function judgeVerdictRows(): Promise<{ detail?: Record<string, unknown> }[]> {
  return (await readAudit({})).filter((r) => r.action === "approval.judge.verdict") as { detail?: Record<string, unknown> }[];
}

{
  clearApprovalJudgeVerdictCache();
  stubJudge({ scrutiny: "YES", verdict: "VERDICT: allow\nREASON: modest cap, attended, clean turn" });
  const allowed = await requestApproval(spendInput, { postCard });
  ok(allowed.autoApproved !== undefined && allowed.autoApproved.resolvedBy === "judge", "enforce/allow: a judge allow auto-approves — no card, the frozen args ran");
  const row = await getOperationalStore().getPendingAction("test-org", allowed.id);
  ok(row != null && row.status === "approved" && row.decidedBy === "chain:judge", "enforce/allow: the wedge row is decided by chain:judge, never a human's id");
  const vRows = await judgeVerdictRows();
  ok(vRows.length === 1, "enforce/allow: exactly one approval.judge.verdict row was written");
  const d = vRows[0]!.detail ?? {};
  ok(d.verdict === "allow" && d.enforcedVerdict === "allow" && d.mode === "enforce", "enforce/allow: the row records the enforced verdict as enforced");
  ok(d.registryVerdict === "ask" && d.tool === "set_spend_limit" && d.action === "spend.set", "enforce/allow: the displaced per-verb default and the verb are on the row");
  ok(d.passes === 2 && typeof d.pass1 === "string" && typeof d.reasoning === "string", "enforce/allow: pass count, pass-1 answer and reasoning summary are on the row");

  clearApprovalJudgeVerdictCache();
  stubJudge({ scrutiny: "YES", verdict: "VERDICT: ask\nREASON: large raise, wants a human" });
  const asked = await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 900_000 } }, { postCard });
  ok(asked.autoApproved === undefined && typeof asked.id === "string", "enforce/ask: a judge ask cards exactly as before the flip");
  const askedRow = (await getOperationalStore().listPendingActions("test-org")).find((r) => r.id === asked.id);
  ok(askedRow !== undefined && askedRow.status === "pending", "enforce/ask: the pending row awaits a human click");
  const askDetail = (await judgeVerdictRows())[0]!.detail ?? {};
  ok(askDetail.verdict === "ask" && askDetail.enforcedVerdict === "ask", "enforce/ask: the consult row records ask beside ask");

  clearApprovalJudgeVerdictCache();
  stubJudge({ scrutiny: "YES", verdict: "VERDICT: deny\nREASON: outside standing policy" });
  let denied: Error | undefined;
  try {
    await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 999_999_999 } }, { postCard });
  } catch (e) {
    denied = e as Error;
  }
  ok(denied !== undefined && /DENIED by the approval judge/.test(denied.message), "enforce/deny: a judge deny refuses the propose with its own sentence (not the config-diff copy)");
  const denyDetail = (await judgeVerdictRows())[0]!.detail ?? {};
  ok(denyDetail.verdict === "deny" && denyDetail.enforcedVerdict === "deny", "enforce/deny: the consult row records the deny (the first live one gets individual review)");

  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
  const degraded = await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 750_000 } }, { postCard });
  ok(degraded.autoApproved === undefined, "enforce/degraded: no transport ⇒ the card path, exactly the pre-flip behaviour");
  const degradedDetail = (await judgeVerdictRows())[0]!.detail ?? {};
  ok(degradedDetail.verdict === "defer" && degradedDetail.source === "unavailable" && degradedDetail.enforcedVerdict === "ask", "enforce/degraded: the consult row still lands — a consult that changed nothing is still evidence");

  const before = (await judgeVerdictRows()).length;
  const control = stubJudge({ scrutiny: "YES", verdict: "VERDICT: allow\nREASON: n/a" });
  const unflipped = await requestApproval(baseInput, { postCard });
  ok(unflipped.autoApproved === undefined, "enforce/control: an unflipped kind (skill.delete) still cards");
  ok((await judgeVerdictRows()).length === before && control.calls.length === 0, "enforce/control: no consult, no row, transport untouched");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

{
  clearApprovalJudgeVerdictCache();
  stubJudge({ scrutiny: "YES", verdict: "VERDICT: allow\nREASON: routine's own standing work" });
  const fireAllowed = await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 100_000 }, chain: { unattended: true } }, { postCard });
  ok(fireAllowed.autoApproved !== undefined && fireAllowed.autoApproved.resolvedBy === "judge", "enforce/unattended: a judge allow lets the fire proceed — no ask ever reached the unattended clamp");

  clearApprovalJudgeVerdictCache();
  stubJudge({ scrutiny: "YES", verdict: "VERDICT: ask\nREASON: wants a human" });
  let fireDenied: Error | undefined;
  try {
    await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 800_000 }, chain: { unattended: true } }, { postCard });
  } catch (e) {
    fireDenied = e as Error;
  }
  ok(fireDenied !== undefined && /ask-unattended/.test(fireDenied.message), "enforce/unattended: a judge ask on a fire takes the ordinary ask→deny clamp (a card in an empty room is toxic)");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

{
  ok((await approvalJudgeBreakerTripped("plain")) === false, "breaker: a clean ledger reads armed");
  const where = { org: "test-org", platform: "domain", workspace: "plain" };
  for (let i = 0; i < APPROVAL_JUDGE_BREAKER_THRESHOLD; i++) {
    await recordApprovalJudgeContradiction(where, { domain: "plain", tool: "set_spend_limit", judgeVerdict: "allow", humanAction: "reject", note: `test contradiction ${i}` });
  }
  ok((await approvalJudgeBreakerTripped("plain")) === true, "breaker: N contradictions in the window trip it for the domain");
  ok((await approvalJudgeBreakerTripped("otherdomain")) === false, "breaker: a sibling domain's judge stays armed (domain-scoped rows count only for their domain)");

  const tripped = stubJudge({ scrutiny: "YES", verdict: "VERDICT: allow\nREASON: n/a" });
  const degraded = await requestApproval({ ...spendInput, args: { ...spendInput.args, monthlyTokens: 250_000 } }, { postCard });
  ok(degraded.autoApproved === undefined, "breaker: the propose cards — a tripped breaker means no lift, ever");
  ok(tripped.calls.length === 0, "breaker: the transport was never consulted");
  const breakerDetail = (await judgeVerdictRows())[0]!.detail ?? {};
  ok(breakerDetail.source === "breaker" && breakerDetail.verdict === "defer" && breakerDetail.enforcedVerdict === "ask", "breaker: the consult row records the disarm (source: breaker) — the degrade is queryable");
  resetApprovalJudgeCompletion();
  clearApprovalJudgeVerdictCache();
}

overrideSettingsForTest({ approvals: { judgeMode: "off" } });

console.log(
  `✓ approval-judge: ${passed} assertions — fail-closed arming (off/shadow/enforce, exact strings only), judge-off ≡ today, per-verb-default shadow eligibility, exemption predicate, two-pass flow with fail-closed defers, taint-invalidated (op, connection) verdict cache, shadow rows beside real cards — and PHASE 2: pass-1 allow short disabled under enforcement, session-or-nothing enforce cache refusing pass-1 entries, bounded timeout with no late cache back-fill, judge allow/ask/deny/degraded/unattended through the live propose plane with per-consult approval.judge.verdict rows, and the contradiction breaker disarming per domain`,
);
rmSync(tmp, { recursive: true, force: true });
