
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

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
  const r = await callJson(client, "clear_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface" });
  ok("clear_spend_limit reports cleared", r.cleared === true);
  ok("effectiveCaps reverts to config after clear", (await effectiveCaps("default", "slack/T1", "slack/T1/C1")).surfaceMonthlyTokens === undefined);
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
  const audit = await readAudit({ org: "default" });
  const actions = audit.map((e) => e.action);
  for (const a of ["admin.spend.set_limit", "admin.spend.clear_limit", "admin.connector.revoke", "admin.connector.clear_override", "admin.routine.cancel"]) {
    ok(`audited: ${a}`, actions.includes(a));
  }
  ok("write actions carry the acting principal", audit.filter((e) => e.action.startsWith("admin.")).every((e) => e.principalId === "admin@example.com"));
}

await client.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ control write tools: ${n} assertions passed (mutations overlay config-as-code + are audited)\n`);
