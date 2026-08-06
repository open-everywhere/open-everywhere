
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import "./_register-test-config.js";

const dir = join(tmpdir(), `open-everywhere-control-write-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer, CONTROL_TOOL_NAMES } = await import("../agent/control/server.js");
const { CONTROL_WRITE_TOOL_NAMES } = await import("../agent/control/writes.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { effectiveCaps, applyCapOverrides } = await import("../agent/spend/caps.js");
const { applyConnectorOverrides } = await import("../agent/access/connector-scope.js");
const { readAudit } = await import("../agent/audit/audit.js");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const callJson = async (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { type: string; text: string }[])[0].text);
};

{
  const readonlyTools = Object.keys((buildControlServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  ok("read-only server has exactly the declared read tools", JSON.stringify(readonlyTools) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));
  const writeTools = Object.keys((buildControlServer({ includeWrites: true, actor: "t" }) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  ok("write server exposes all the mutating tools", CONTROL_WRITE_TOOL_NAMES.every((t) => writeTools.includes(t)));
  ok("write server still exposes the read tools", CONTROL_TOOL_NAMES.every((t) => writeTools.includes(t)));
}

const server = buildControlServer({ includeWrites: true, actor: "admin@example.com" });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "write-test", version: "0" });
await client.connect(clientT);

{
  const before = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("no override → config caps (uncapped)", before.surfaceMonthlyTokens === undefined);
  const r = await callJson(client, "set_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 1000 });
  ok("set_spend_limit returns ok", r.ok === true && r.monthlyTokens === 1000);
  const after = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("effectiveCaps now reflects the admin-set surface limit", after.surfaceMonthlyTokens === 1000);
  ok("the override is scoped to its surface", (await effectiveCaps("default", "slack/T1", "slack/T1/C2")).surfaceMonthlyTokens === undefined);
  ok("applyCapOverrides is the pure form of the overlay", applyCapOverrides({}, [{ org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 1000 }], "slack/T1", "slack/T1/C1").surfaceMonthlyTokens === 1000);
}

{
  const r = await callJson(client, "set_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyUsd: 25.5 });
  ok("set_spend_limit accepts a USD-only override", r.ok === true && r.monthlyUsd === 25.5 && r.monthlyTokens === undefined);
  const after = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("effectiveCaps reflects the admin-set USD limit", after.surfaceMonthlyUsd === 25.5);
  ok("the USD-only row replaced the token row (one override per scope+level)", after.surfaceMonthlyTokens === undefined);
  const bad = await client.callTool({ name: "set_spend_limit", arguments: { org: "default", scopeKey: "slack/T1/C1", level: "surface" } });
  ok("set_spend_limit with no component is refused", bad.isError === true);
}

{
  const r = await callJson(client, "clear_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface" });
  ok("clear_spend_limit reports cleared", r.cleared === true);
  const after = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("effectiveCaps reverts to config after clear", after.surfaceMonthlyTokens === undefined && after.surfaceMonthlyUsd === undefined);
}

{
  await callJson(client, "revoke_connector", { org: "default", surfaceKey: "slack/T1/C1", connector: "notion" });
  let ov = await getOperationalStore().connectorOverrides("default", "slack/T1/C1");
  ok("revoke_connector persists a denied override", ov.some((o) => o.connector === "notion" && o.granted === false));
  ok("overlay removes a revoked connector even if config granted it", !applyConnectorOverrides(["notion"], ov).includes("notion"));

  ok(
    "overlay never widens: a granted=true override does not add an un-configured connector",
    !applyConnectorOverrides([], [{ connector: "notion", granted: true }]).includes("notion"),
  );
  ok(
    "overlay never widens: granted=true is inert even alongside the base",
    JSON.stringify(applyConnectorOverrides(["linear"], [{ connector: "notion", granted: true }])) === JSON.stringify(["linear"]),
  );

  const r = await callJson(client, "clear_connector_override", { org: "default", surfaceKey: "slack/T1/C1", connector: "notion" });
  ok("clear_connector_override reports cleared", r.cleared === true);
  ov = await getOperationalStore().connectorOverrides("default", "slack/T1/C1");
  ok("clear removes the override row (reverts to config)", !ov.some((o) => o.connector === "notion"));
  const again = await callJson(client, "clear_connector_override", { org: "default", surfaceKey: "slack/T1/C1", connector: "notion" });
  ok("clearing a missing override reports cleared=false", again.cleared === false);
}

{
  await getOperationalStore().addRoutine({ id: "r-1", org: "default", surfaceKey: "slack/T1/C1", trigger: { kind: "interval", everyMinutes: 60 }, prompt: "x", createdAt: "2026-06-25T00:00:00Z", status: "active", consecutiveFailures: 0 });
  const r = await callJson(client, "cancel_routine", { org: "default", surfaceKey: "slack/T1/C1", id: "r-1" });
  ok("cancel_routine cancels an existing routine", r.cancelled === true);
  ok("routine is gone after cancel", (await getOperationalStore().listRoutines("default", "slack/T1/C1")).length === 0);
  const miss = await callJson(client, "cancel_routine", { org: "default", surfaceKey: "slack/T1/C1", id: "nope" });
  ok("cancelling a missing routine reports cancelled=false", miss.cancelled === false);
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists delete_skill", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("delete_skill"));

  await getOperationalStore().putDomainSkill("default", "eng", "runbook", "# Steps", "U1", "2026-07-04T10:00:00Z");

  const otherDomainServer = buildControlServer({ includeWrites: true, actor: "other-op", roles: ["domain:other"] });
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await otherDomainServer.connect(s1);
  const otherClient = new Client({ name: "delete-skill-denied", version: "0" });
  await otherClient.connect(c1);
  const denied = await otherClient.callTool({ name: "delete_skill", arguments: { org: "default", domain: "eng", name: "runbook" } });
  ok("delete_skill: an uncovered domain role is denied", denied.isError === true);
  ok(
    "delete_skill: a denied call doesn't touch the store",
    (await getOperationalStore().listDomainSkills("default", "eng")).some((s: { name: string }) => s.name === "runbook"),
  );
  await otherClient.close();

  const r = await callJson(client, "delete_skill", { org: "default", domain: "eng", name: "runbook" });
  ok("delete_skill: happy path deletes the seeded skill", r.ok === true && r.deleted === true);
  ok(
    "delete_skill: skill is gone from the store",
    !(await getOperationalStore().listDomainSkills("default", "eng")).some((s: { name: string }) => s.name === "runbook"),
  );

  const miss = await callJson(client, "delete_skill", { org: "default", domain: "eng", name: "runbook" });
  ok("delete_skill: deleting an already-gone skill reports deleted:false (not an error)", miss.ok === true && miss.deleted === false);
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists directory_groups_plan", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("directory_groups_plan"));
  const planOnly = await callJson(client, "directory_groups_plan", { org: "default" });
  ok("directory_groups_plan is cleanly-off with no directory adapter (plan mode)", planOnly.ok === true && planOnly.provider === null);
  const deliver = await callJson(client, "directory_groups_plan", { org: "default", deliver: true });
  ok("directory_groups_plan deliver:true is cleanly-off with no directory adapter (never reaches the repo gate)", deliver.ok === true && deliver.provider === null);
}

{
  const r = await callJson(client, "set_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 5000, ttlSeconds: 3600, reason: "blocked mid-task" });
  ok("set_spend_limit with ttlSeconds returns a future expiresAt", typeof r.expiresAt === "number" && r.expiresAt > Date.now());
  ok("a future-dated bridge is still applied", (await effectiveCaps("default", "slack/T1", "slack/T1/C1")).surfaceMonthlyTokens === 5000);
  const row = (await getOperationalStore().spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1" && l.level === "surface");
  ok("the spend override stores reason + setBy (the actor)", row?.reason === "blocked mid-task" && row?.setBy === "admin@example.com");

  await callJson(client, "revoke_connector", { org: "default", surfaceKey: "slack/T1/C1", connector: "linear", reason: "leaked token" });

  const drift = await callJson(client, "overrides_list", { org: "default" });
  const sd = drift.spend.find((s: { scopeKey: string; level: string }) => s.scopeKey === "slack/T1/C1" && s.level === "surface");
  ok("drift view lists the spend override with reason/setBy", sd?.reason === "blocked mid-task" && sd?.setBy === "admin@example.com");
  ok("drift view flags the raised cap as diverging, not expired", sd?.divergesFromConfig === true && sd?.expired === false);
  const cd = drift.connectors.find((c: { connector: string }) => c.connector === "linear");
  ok("drift view lists the revoke as sticky with reason", cd?.sticky === true && cd?.granted === false && cd?.reason === "leaked token");

  await callJson(client, "clear_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface" });
  await callJson(client, "clear_connector_override", { org: "default", surfaceKey: "slack/T1/C1", connector: "linear" });
}

{
  const r = await callJson(client, "cancel_routine", { org: "default", surfaceKey: "payments", id: "no-such-routine" });
  ok("a bare domain-name scope is accepted by the write plane (no format constraint on the param)", r.ok === true && r.cancelled === false);
  const rows = (await readAudit({ org: "default" })).filter((e) => e.action === "admin.routine.cancel" && (e.detail as { id?: string })?.id === "no-such-routine");
  ok("the domain-scoped mutation produced exactly one audit row", rows.length === 1);
  ok(
    "a bare domain NAME audits as platform:'domain' with the domain as the workspace",
    rows[0]?.platform === "domain" && rows[0]?.workspace === "payments",
  );
  ok(
    "…and NOT as the deleted private copy had it — a platform that does not exist, with an unknown workspace",
    !(rows[0]?.platform === "payments" && rows[0]?.workspace === "unknown"),
  );
}

{
  const audit = await readAudit({ org: "default" });
  const actions = audit.map((e) => e.action);
  for (const a of ["admin.spend.set_limit", "admin.spend.clear_limit", "admin.connector.revoke", "admin.connector.clear_override", "admin.routine.cancel", "skill.delete"]) {
    ok(`audited: ${a}`, actions.includes(a));
  }
  ok("write actions carry the acting principal", audit.filter((e) => e.action.startsWith("admin.")).every((e) => e.principalId === "admin@example.com"));
  ok(
    "delete_skill audits with the control actor, same action string the agent-side delete_skill tool uses (skill.delete)",
    audit.some((e) => e.action === "skill.delete" && e.principalId === "admin@example.com" && (e.detail as { name?: string })?.name === "runbook"),
  );
}

await client.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ control write tools: ${n} assertions passed (mutations overlay config-as-code + are audited)\n`);
