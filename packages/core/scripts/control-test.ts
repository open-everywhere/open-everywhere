import "./_register-test-config.js";
import assert from "node:assert/strict";
import { spendView, routinesView, auditView, accessView } from "../agent/control/views.js";
import { buildControlServer, CONTROL_TOOL_NAMES } from "../agent/control/server.js";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};
const spend = await spendView();
ok("spendView has a period", /^\d{4}-\d{2}$/.test(spend.period));
ok("spendView surfaces is an array", Array.isArray(spend.surfaces));
ok("spendView workspaces is an array", Array.isArray(spend.workspaces));
ok("spendView is JSON-serialisable", typeof JSON.stringify(spend) === "string");

const spend2 = await spendView("2020-01");
ok("spendView honours an explicit period", spend2.period === "2020-01");

const routines = await routinesView();
ok("routinesView reports a total", typeof routines.total === "number");
ok("routinesView routines is an array", Array.isArray(routines.routines));
const due = await routinesView({ onlyDue: true });
ok("routinesView --due reports dueCount", typeof due.dueCount === "number");
ok("routinesView --due never exceeds total", due.routines.length <= routines.total);

const audit = await auditView({ limit: 5 });
ok("auditView entries is an array", Array.isArray(audit.entries));
ok("auditView respects the limit", audit.entries.length <= 5);
ok("auditView echoes the resolved filter limit", audit.filter.limit === 5);

const access = await accessView({ platform: "local", workspace: "dev", channel: "default" });
ok("accessView resolves a scopeKey", typeof access.scopeKey === "string" && access.scopeKey.length > 0);
ok("accessView connectors is an array", Array.isArray(access.connectors));
for (const c of access.connections) {
  ok(`connection ${c.id} exposes only a secretRef name, never a value`, !("secret" in c) && !("token" in c) && !("authorization" in c));
}

const server = buildControlServer();
const reg = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
const registered = Object.keys(reg).sort();
ok("server exposes the declared tool names", JSON.stringify(registered) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));
ok("no mutating tool leaked into slice 1", !registered.some((t) => /set|grant|revoke|cancel|create|update|delete|rotate/.test(t)));

console.log(`\n✓ control surface: ${n} assertions passed (${registered.length} tools: ${registered.join(", ")})\n`);
