import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import "./_register-test-config.js";

const dir = join(tmpdir(), `open-everywhere-control-approvals-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer, CONTROL_TOOL_NAMES } = await import("../agent/control/server.js");
const { CONTROL_WRITE_TOOL_NAMES } = await import("../agent/control/writes.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { effectiveCaps } = await import("../agent/spend/caps.js");
const { readAudit } = await import("../agent/audit/audit.js");
import type { PendingActionRow } from "../agent/approvals/types.js";

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
  const row: PendingActionRow = {
    id,
    org: "default",
    kind: "spend.set",
    argsJson: JSON.stringify({ org: "default", scopeKey, level, monthlyTokens: tokens, currentCap: null }),
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

await client.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ control approvals tools: ${n} assertions passed (decide reuses the CAS core + executes; list is redacted + role-filtered; RBAC + domain-cap carve-out hold)\n`);
