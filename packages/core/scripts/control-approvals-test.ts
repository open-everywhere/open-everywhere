import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./_register-test-config.js";

const dir = join(tmpdir(), `open-everywhere-control-approvals-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "default" });

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer, CONTROL_TOOL_NAMES } = await import("../agent/control/server.js");
const { CONTROL_WRITE_TOOL_NAMES } = await import("../agent/control/writes.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { effectiveCaps } = await import("../agent/spend/caps.js");
const { readAudit } = await import("../agent/audit/audit.js");
import type { PendingActionRow } from "../agent/approvals/types.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

type ToolClient = InstanceType<typeof Client>;
const callJson = async (client: ToolClient, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { type: string; text: string }[])[0].text);
};

{
  ok("pending_actions_list is a declared READ tool", (CONTROL_TOOL_NAMES as readonly string[]).includes("pending_actions_list"));
  ok("decide_pending_action is a declared WRITE tool", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("decide_pending_action"));
  const readonlyTools = Object.keys((buildControlServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  ok("read-only server exposes pending_actions_list but NOT decide_pending_action", readonlyTools.includes("pending_actions_list") && !readonlyTools.includes("decide_pending_action"));
}

const store = getOperationalStore();
const now = new Date().toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();

const seed = async (id: string, over: Partial<PendingActionRow> & { tokens?: number; level?: string } = {}): Promise<void> => {
  const { tokens = 2222, level = "surface", ...rowOver } = over;
  const scopeKey = rowOver.scopeKey ?? "slack/T1/C7";
  const org = rowOver.org ?? "default";
  const row: PendingActionRow = {
    id,
    org,
    kind: "spend.set",
    argsJson: JSON.stringify({ org, scopeKey, level, monthlyTokens: tokens, currentCap: null }),
    scopeKey,
    domain: rowOver.domain ?? "eng",
    requestedBy: "U9",
    channelId: "C7",
    threadTs: null,
    messageTs: "1.1",
    postedTo: null,
    status: "pending",
    createdAt: now,
    expiresAt: future,
    decidedBy: null,
    decidedAt: null,
    ...rowOver,
  };
  await store.addPendingAction(row);
};

const server = buildControlServer({ includeWrites: true, actor: "admin@example.com" });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "approvals-test", version: "0" });
await client.connect(clientT);

{
  await seed("pa-approve");
  const list = await callJson(client, "pending_actions_list", { org: "default" });
  const p = list.pending.find((x: { id: string }) => x.id === "pa-approve");
  ok("list surfaces the pending action", !!p);
  ok("list carries a code-rendered summary, requestedBy, age, kind, policy", Array.isArray(p.summary) && p.summary.length > 0 && p.requestedBy === "U9" && typeof p.ageSeconds === "number" && p.kind === "spend.set" && p.policy === "admin");
  ok("REDACTION: list never leaks the raw frozen args blob", list.pending.every((x: Record<string, unknown>) => x.argsJson === undefined && x.args === undefined));
  ok("summary is the human card text, not the raw args", p.summary.some((line: string) => /spend limit/i.test(line)));

  const foreign = await client.callTool({ name: "pending_actions_list", arguments: { org: "other-tenant" } });
  ok("🔴 pending_actions_list naming another org is REFUSED — an approvals queue is that tenant's live decisions", foreign.isError === true);
}

{
  const before = await effectiveCaps("default", "slack/T1", "slack/T1/C7");
  ok("no cap set before approve", before.surfaceMonthlyTokens === undefined);
  const r = await callJson(client, "decide_pending_action", { org: "default", id: "pa-approve", decision: "approve" });
  ok("approve decides + reports approved", r.ok === true && r.outcome === "decided" && r.decision === "approved" && r.decidedBy === "admin@example.com");
  ok("approve EXECUTED the frozen spend.set (limit now applied)", (await effectiveCaps("default", "slack/T1", "slack/T1/C7")).surfaceMonthlyTokens === 2222);
  ok("an approved row leaves the pending queue", (await callJson(client, "pending_actions_list", { org: "default" })).pending.every((x: { id: string }) => x.id !== "pa-approve"));
  const again = await callJson(client, "decide_pending_action", { org: "default", id: "pa-approve", decision: "approve" });
  ok("double-decide is CAS-safe (already-decided, not an error)", again.ok === true && again.outcome === "already-decided");
  await callJson(client, "clear_spend_limit", { org: "default", scopeKey: "slack/T1/C7", level: "surface" });
}

{
  await seed("pa-deny", { scopeKey: "slack/T1/C8", tokens: 3333 });
  const r = await callJson(client, "decide_pending_action", { org: "default", id: "pa-deny", decision: "deny" });
  ok("deny decides + reports rejected", r.ok === true && r.outcome === "decided" && r.decision === "rejected");
  ok("deny did NOT execute the mutation (no cap set)", (await effectiveCaps("default", "slack/T1", "slack/T1/C8")).surfaceMonthlyTokens === undefined);
  const persisted = await store.getPendingAction("default", "pa-deny");
  ok("rejected row is terminal, decidedBy = the control identity", persisted?.status === "rejected" && persisted?.decidedBy === "admin@example.com");
}

{
  await seed("pa-halted", { scopeKey: "slack/T1/C-HALT", tokens: 4444 });
  await store.setHalt("default", { orgWide: true }, { setBy: "admin@example.com" });
  const refused = await client.callTool({ name: "decide_pending_action", arguments: { org: "default", id: "pa-halted", decision: "approve" } });
  ok("🔴 OPE-1604: a control-plane decide during an org-wide halt is REFUSED", refused.isError === true);
  ok(
    "🔴 OPE-1604: and it did NOT execute the frozen mutation — no cap was set",
    (await effectiveCaps("default", "slack/T1", "slack/T1/C-HALT")).surfaceMonthlyTokens === undefined,
  );
  ok("🔴 OPE-1604: the halt edits no row — the pending is still pending for the same operator after `resume`", (await store.getPendingAction("default", "pa-halted"))?.status === "pending");
  ok(
    "🔴 OPE-1604: the door relays core's OWN halt sentence, not a generic \"unexpected resolution\" line",
    JSON.stringify(refused.content ?? "").includes("emergency halt is on") && !JSON.stringify(refused.content ?? "").includes("unexpected resolution"),
  );

  await store.clearHalt("default", { orgWide: true }, { clearedBy: "admin@example.com" });
  const after = await callJson(client, "decide_pending_action", { org: "default", id: "pa-halted", decision: "approve" });
  ok("🔴 OPE-1604 NEGATIVE CONTROL: with the halt cleared the identical decide succeeds and executes", after.ok === true && after.outcome === "decided");
  ok("OPE-1604 NEGATIVE CONTROL: …and the frozen mutation really ran", (await effectiveCaps("default", "slack/T1", "slack/T1/C-HALT")).surfaceMonthlyTokens === 4444);
  await callJson(client, "clear_spend_limit", { org: "default", scopeKey: "slack/T1/C-HALT", level: "surface" });
}

{
  const miss = await client.callTool({ name: "decide_pending_action", arguments: { org: "default", id: "does-not-exist", decision: "approve" } });
  ok("deciding an unknown pending → tool error", miss.isError === true);
}

{
  const audit = await readAudit({ org: "default" });
  const actions = audit.map((e) => e.action);
  ok("the executed decision is audited by the shared core (approval.approved)", actions.includes("approval.approved"));
  ok("the deny is audited by the shared core (approval.rejected)", actions.includes("approval.rejected"));
  ok("control-plane provenance is audited (admin.approval.decide) with the actor", audit.some((e) => e.action === "admin.approval.decide" && e.principalId === "admin@example.com"));
}

{
  await seed("pa-rbac", { scopeKey: "slack/T1/C9", tokens: 4444, domain: "eng" });

  const otherServer = buildControlServer({ includeWrites: true, actor: "other-op", roles: ["domain:other"] });
  const [c2, s2] = InMemoryTransport.createLinkedPair();
  await otherServer.connect(s2);
  const otherClient = new Client({ name: "decide-denied", version: "0" });
  await otherClient.connect(c2);
  const denied = await otherClient.callTool({ name: "decide_pending_action", arguments: { org: "default", id: "pa-rbac", decision: "approve" } });
  ok("decide_pending_action: an uncovered domain role is denied", denied.isError === true);
  ok("a denied decide leaves the row pending (no CAS, no execute)", (await store.getPendingAction("default", "pa-rbac"))?.status === "pending");
  const otherList = await callJson(otherClient, "pending_actions_list", { org: "default" });
  ok("list is row-filtered: domain:other sees no eng-domain pending", otherList.pending.every((x: { id: string }) => x.id !== "pa-rbac"));
  await otherClient.close();

  const engServer = buildControlServer({ includeWrites: true, actor: "eng-lead", roles: ["domain:eng"] });
  const [c3, s3] = InMemoryTransport.createLinkedPair();
  await engServer.connect(s3);
  const engClient = new Client({ name: "decide-eng", version: "0" });
  await engClient.connect(c3);
  const engList = await callJson(engClient, "pending_actions_list", { org: "default" });
  ok("a domain:eng role sees its own domain's pending", engList.pending.some((x: { id: string }) => x.id === "pa-rbac"));
  const engDecide = await callJson(engClient, "decide_pending_action", { org: "default", id: "pa-rbac", decision: "deny" });
  ok("a domain:eng role can decide its own domain's pending", engDecide.ok === true && engDecide.outcome === "decided" && engDecide.decision === "rejected");
  await engClient.close();
}

{
  await seed("pa-domcap", { scopeKey: "eng", domain: "eng", level: "domain", tokens: 5555 });

  const engServer = buildControlServer({ includeWrites: true, actor: "eng-lead", roles: ["domain:eng"] });
  const [c4, s4] = InMemoryTransport.createLinkedPair();
  await engServer.connect(s4);
  const engClient = new Client({ name: "domcap", version: "0" });
  await engClient.connect(c4);
  const domcapDenied = await engClient.callTool({ name: "decide_pending_action", arguments: { org: "default", id: "pa-domcap", decision: "approve" } });
  ok("a domain admin CANNOT decide a domain-level spend cap (org-admin only)", domcapDenied.isError === true);
  ok("the denied domain-cap row is still pending", (await store.getPendingAction("default", "pa-domcap"))?.status === "pending");
  const engList = await callJson(engClient, "pending_actions_list", { org: "default" });
  ok("the domain admin can still SEE the domain-cap pending", engList.pending.some((x: { id: string }) => x.id === "pa-domcap"));
  await engClient.close();

  const orgOk = await callJson(client, "decide_pending_action", { org: "default", id: "pa-domcap", decision: "deny" });
  ok("an org admin CAN decide a domain-level spend cap", orgOk.ok === true && orgOk.outcome === "decided");
}

{
  await seed("pa-usercap", { scopeKey: "user:slack/T1/U_ENG_MEMBER", domain: "eng", level: "user", tokens: 7777 });

  const engServer = buildControlServer({ includeWrites: true, actor: "eng-lead", roles: ["domain:eng"] });
  const [c5, s5] = InMemoryTransport.createLinkedPair();
  await engServer.connect(s5);
  const engClient = new Client({ name: "usercap", version: "0" });
  await engClient.connect(c5);
  const denied = await engClient.callTool({ name: "decide_pending_action", arguments: { org: "default", id: "pa-usercap", decision: "approve" } });
  ok("🔴 a domain admin CANNOT decide a PER-USER spend cap over the control plane either (org-admin only)", denied.isError === true);
  ok("the denied per-user row is still pending — the refusal happened before the decide CAS", (await store.getPendingAction("default", "pa-usercap"))?.status === "pending");
  await engClient.close();

  const orgOk = await callJson(client, "decide_pending_action", { org: "default", id: "pa-usercap", decision: "deny" });
  ok("an org admin CAN decide a per-user spend cap", orgOk.ok === true && orgOk.outcome === "decided");
}

{
  await seed("pa-foreign-usercap", { org: "other-tenant", scopeKey: "user:slack/T9/U_OTHER", domain: "eng", level: "user", tokens: 9999 });
  await seed("pa-own-usercap", { scopeKey: "user:slack/T1/U_ENG_MEMBER2", domain: "eng", level: "user", tokens: 8888 });

  const foreign = await client.callTool({ name: "decide_pending_action", arguments: { org: "other-tenant", id: "pa-foreign-usercap", decision: "approve" } });
  ok("🔴 an org admin approving ANOTHER tenant's pending spend cap is REFUSED", foreign.isError === true);
  const foreignText = (foreign.content as { type: string; text: string }[])[0].text;
  ok("the refusal is the ORG denial, not a role denial — it names both orgs", /is not this deployment's org/.test(foreignText) && foreignText.includes("other-tenant"));

  const untouched = await store.getPendingAction("other-tenant", "pa-foreign-usercap");
  ok("the foreign tenant's row is untouched: still pending, no decider, no decide time", untouched?.status === "pending" && untouched?.decidedBy === null && untouched?.decidedAt === null);
  ok("the refused decide wrote NOTHING into the foreign tenant's audit partition", (await readAudit({ org: "other-tenant" })).length === 0);

  const own = await callJson(client, "decide_pending_action", { org: "default", id: "pa-own-usercap", decision: "deny" });
  ok("positive control: the SAME admin still decides this deployment's own per-user cap", own.ok === true && own.outcome === "decided" && own.decision === "rejected");
}

{
  const { approvalJudgeAdminDisarmed } = await import("../agent/access/approval-judge.js");
  const contradictions = async () =>
    (await readAudit({ org: "default", action: "approval.judge.contradicted" })) as { principalId?: string; detail?: Record<string, unknown> }[];

  ok("disarm_approval_judge is a declared WRITE tool", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("disarm_approval_judge"));
  ok("rearm_approval_judge is a declared WRITE tool", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("rearm_approval_judge"));
  const readOnlyNames = Object.keys((buildControlServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  ok("the read-only server does NOT expose the disarm", !readOnlyNames.includes("disarm_approval_judge"));
  ok("🔴 the read-only server does NOT expose the rearm either — re-arming a judge an operator turned off is a WRITE", !readOnlyNames.includes("rearm_approval_judge"));

  ok("the target domain's judge reads ARMED before the call", (await approvalJudgeAdminDisarmed("eng", "default")) === false);
  ok("no ledger row exists before an operator acts", (await contradictions()).length === 0);

  const otherServer = buildControlServer({ includeWrites: true, actor: "other-op", roles: ["domain:other"] });
  const [c6, s6] = InMemoryTransport.createLinkedPair();
  await otherServer.connect(s6);
  const otherClient = new Client({ name: "disarm-rbac", version: "0" });
  await otherClient.connect(c6);
  const refused = await otherClient.callTool({ name: "disarm_approval_judge", arguments: { org: "default", domain: "eng" } });
  ok("a non-covering role CANNOT disarm the judge for a domain", refused.isError === true);
  ok("the refused call wrote no ledger row", (await contradictions()).length === 0);
  ok("the refused call left the judge armed", (await approvalJudgeAdminDisarmed("eng", "default")) === false);

  const foreignOrg = await client.callTool({ name: "disarm_approval_judge", arguments: { org: "some-other-org", domain: "eng" } });
  ok("🔴 a disarm naming an org that is not this deployment's is REFUSED", foreignOrg.isError === true);
  ok("the refused foreign-org disarm wrote no ledger row", (await contradictions()).length === 0);
  ok("🔴 and left the judge ARMED — the operator is told, rather than believing a no-op worked", (await approvalJudgeAdminDisarmed("eng", "default")) === false);
  const foreignRearm = await client.callTool({ name: "rearm_approval_judge", arguments: { org: "some-other-org", orgWide: true } });
  ok("the symmetric re-arm refuses a foreign org too", foreignRearm.isError === true);

  const done = await callJson(client, "disarm_approval_judge", { org: "default", domain: "eng" });
  ok("the org admin's disarm reports success for the named domain", done.ok === true && done.domain === "eng" && done.disarmed === true);
  ok("🔴 the disarm result no longer advertises a lapse window — it lasts until an operator re-arms", done.windowDays === undefined);
  const rows = await contradictions();
  ok("ONE row per operator act", rows.length === 1);
  ok("the row names the domain, the act and the route", (rows[0]!.detail ?? {}).domain === "eng" && (rows[0]!.detail ?? {}).humanAction === "admin-disarm" && (rows[0]!.detail ?? {}).route === "control");
  ok("the row names WHO disarmed", rows[0]!.principalId === "admin@example.com");
  ok("🔴 the judge is now DISARMED for that domain off ONE row", (await approvalJudgeAdminDisarmed("eng", "default")) === true);
  ok("a sibling domain's judge stays armed", (await approvalJudgeAdminDisarmed("other", "default")) === false);

  const provenance = (await readAudit({ org: "default", action: "admin.approval.judge_disarm" })) as { principalId?: string; detail?: Record<string, unknown> }[];
  ok("a control-plane provenance row names the door and the operator", provenance.length === 1 && provenance[0]!.principalId === "admin@example.com" && (provenance[0]!.detail ?? {}).domain === "eng");

  const refusedRearm = await otherClient.callTool({ name: "rearm_approval_judge", arguments: { org: "default", domain: "eng" } });
  ok("🔴 a non-covering role CANNOT re-arm the judge for a domain", refusedRearm.isError === true);
  ok("the refused re-arm wrote no ledger row", (await contradictions()).length === 1);
  ok("🔴 the refused re-arm left the judge DISARMED — an unauthorised call cannot restore a judge an operator turned off", (await approvalJudgeAdminDisarmed("eng", "default")) === true);
  await otherClient.close();

  const rearmed = await callJson(client, "rearm_approval_judge", { org: "default", domain: "eng" });
  ok("the org admin's re-arm reports success for the named domain", rearmed.ok === true && rearmed.domain === "eng" && rearmed.rearmed === true);
  const afterRearm = await contradictions();
  ok("the re-arm appended ONE row", afterRearm.length === 2);
  const rearmRow = afterRearm.find((r) => (r.detail ?? {}).humanAction === "admin-rearm")!;
  ok("the re-arm row names the domain, the act and the route", rearmRow !== undefined && (rearmRow.detail ?? {}).domain === "eng" && (rearmRow.detail ?? {}).route === "control");
  ok("the re-arm row names WHO re-armed", rearmRow.principalId === "admin@example.com");
  ok("🔴 the judge is ARMED again for that domain", (await approvalJudgeAdminDisarmed("eng", "default")) === false);
  ok("🔴 the cancelled disarm row survives — the ledger is append-only", afterRearm.some((r) => (r.detail ?? {}).humanAction === "admin-disarm" && (r.detail ?? {}).domain === "eng"));

  const rearmProvenance = (await readAudit({ org: "default", action: "admin.approval.judge_rearm" })) as { principalId?: string; detail?: Record<string, unknown> }[];
  ok("a control-plane provenance row names the re-arm door and the operator", rearmProvenance.length === 1 && rearmProvenance[0]!.principalId === "admin@example.com" && (rearmProvenance[0]!.detail ?? {}).domain === "eng");

  const rbacServer = buildControlServer({ includeWrites: true, actor: "eng-op", roles: ["domain:eng"] });
  const [c7, s7] = InMemoryTransport.createLinkedPair();
  await rbacServer.connect(s7);
  const engOnly = new Client({ name: "orgwide-rbac", version: "0" });
  await engOnly.connect(c7);

  const rowsBeforeOrgWide = (await contradictions()).length;
  ok("the org plane reads ARMED before anyone acts on it", (await approvalJudgeAdminDisarmed(undefined, "default")) === false);

  const orgWideRefused = await engOnly.callTool({ name: "disarm_approval_judge", arguments: { org: "default", orgWide: true } });
  ok("🔴 a domain:eng role CANNOT disarm the judge org-wide — the org-wide form is an unscoped ask and needs \"admin\"", orgWideRefused.isError === true);
  ok("the refused org-wide disarm wrote no ledger row", (await contradictions()).length === rowsBeforeOrgWide);
  ok("🔴 the refused org-wide disarm left the domain-less plane ARMED", (await approvalJudgeAdminDisarmed(undefined, "default")) === false);
  const engCovered = await callJson(engOnly, "disarm_approval_judge", { org: "default", domain: "eng" });
  ok("RBAC control: the same domain:eng role CAN disarm its own domain over this door", engCovered.ok === true && engCovered.domain === "eng");
  await callJson(client, "rearm_approval_judge", { org: "default", domain: "eng" });

  const orgWideRearmRefused = await engOnly.callTool({ name: "rearm_approval_judge", arguments: { org: "default", orgWide: true } });
  ok("🔴 a domain:eng role CANNOT re-arm the judge org-wide either — the control is not one-way", orgWideRearmRefused.isError === true);

  const errText = (res: Awaited<ReturnType<typeof client.callTool>>): string =>
    (res.content as { type: string; text: string }[] | undefined)?.map((c) => c.text ?? "").join(" ") ?? "";
  const namesTheRule = (res: Awaited<ReturnType<typeof client.callTool>>): boolean =>
    res.isError === true && errText(res).includes("exactly one address");

  const rowsBeforeMalformed = (await contradictions()).length;
  const bothAddresses = await client.callTool({ name: "disarm_approval_judge", arguments: { org: "default", domain: "eng", orgWide: true } });
  ok("🔴 naming BOTH `domain` and `orgWide` is REFUSED BY THE SCHEMA — an ambiguous address never reaches the handler", namesTheRule(bothAddresses));
  const noAddress = await client.callTool({ name: "disarm_approval_judge", arguments: { org: "default" } });
  ok("🔴 naming NEITHER address is refused too — there is no bare, address-less disarm", namesTheRule(noAddress));
  const bothRearm = await client.callTool({ name: "rearm_approval_judge", arguments: { org: "default", domain: "eng", orgWide: true } });
  ok("🔴 the re-arm takes the SAME schema — the two verbs cannot drift into accepting different addresses", namesTheRule(bothRearm));
  ok("no malformed call wrote a ledger row", (await contradictions()).length === rowsBeforeMalformed);
  ok("🔴 no malformed call moved the org plane", (await approvalJudgeAdminDisarmed(undefined, "default")) === false);
  await engOnly.close();

  const orgDisarm = await callJson(client, "disarm_approval_judge", { org: "default", orgWide: true });
  ok("an org admin's org-wide disarm reports success on the org address", orgDisarm.ok === true && orgDisarm.orgWide === true && orgDisarm.disarmed === true);
  ok("🔴 the org-wide result names NO domain — the two addresses are different populations", orgDisarm.domain === undefined);
  ok("🔴 the domain-less plane is now DISARMED — break-glass reaches `pr.open` and `create_routine`", (await approvalJudgeAdminDisarmed(undefined, "default")) === true);
  ok("🔴 a DOMAIN is left armed by it — `orgWide` is not a wildcard over the per-domain rules", (await approvalJudgeAdminDisarmed("eng", "default")) === false);
  const orgLedgerRow = (await contradictions()).find((r) => (r.detail ?? {}).orgWide === true && (r.detail ?? {}).humanAction === "admin-disarm")!;
  ok("the org-wide ledger row carries the explicit marker, names no domain, and names who acted", orgLedgerRow !== undefined && (orgLedgerRow.detail ?? {}).domain === undefined && orgLedgerRow.principalId === "admin@example.com");
  const orgProvenance = (await readAudit({ org: "default", action: "admin.approval.judge_disarm" })) as { detail?: Record<string, unknown> }[];
  ok("the provenance row carries the org marker too, not a domain", orgProvenance.some((r) => (r.detail ?? {}).orgWide === true && (r.detail ?? {}).domain === undefined));

  const orgRearm = await callJson(client, "rearm_approval_judge", { org: "default", orgWide: true });
  ok("an org admin's org-wide re-arm reports success on the org address", orgRearm.ok === true && orgRearm.orgWide === true && orgRearm.rearmed === true);
  ok("🔴 the domain-less plane is ARMED again", (await approvalJudgeAdminDisarmed(undefined, "default")) === false);
}

await client.close();
await removeTempDir(dir);
console.log(`\n✓ control approvals tools: ${n} assertions passed (decide reuses the CAS core + executes; list is redacted + role-filtered; RBAC + domain-cap carve-out hold; disarm_approval_judge disarms one domain off one RBAC-gated row and rearm_approval_judge restores it, both write-only and append-only; both also take the ORG-WIDE address, which needs \"admin\", governs the domain-less consults only, and is exclusive with \`domain\` in the schema; a decide during a break-glass halt is refused on this door too, in core's own words, editing no row — and succeeds once the halt is cleared)\n`);
