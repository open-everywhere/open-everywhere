import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import "./_register-test-config.js";

const dir = join(tmpdir(), `open-everywhere-control-audit-scope-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "home-org" });
const FOREIGN_ORG = "other-tenant";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer } = await import("../agent/control/server.js");
const { appendAudit } = await import("../agent/audit/audit.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

interface AuditWireEntry {
  readonly org: string;
  readonly action: string;
  readonly principalId?: string;
  readonly detail?: Record<string, unknown>;
}

ok("the deployment org is the one this test pins against", deploymentOrg() === "home-org");

await appendAudit({
  org: deploymentOrg(),
  platform: "domain",
  workspace: "eng",
  principalId: "U_HOME_OPS",
  action: "approval.judge.contradicted",
  detail: { domain: "eng", humanAction: "admin-disarm", route: "control" },
});
await appendAudit({
  org: FOREIGN_ORG,
  platform: "domain",
  workspace: "eng",
  principalId: "U_FOREIGN_OPS",
  action: "approval.judge.contradicted",
  detail: { domain: "eng", humanAction: "admin-rearm", route: "control" },
});
await appendAudit({ org: deploymentOrg(), platform: "slack", workspace: "T_HOME", principalId: "U_HOME", action: "memory.write", detail: {} });
await appendAudit({ org: FOREIGN_ORG, platform: "slack", workspace: "T_FOREIGN", principalId: "U_FOREIGN", action: "memory.write", detail: {} });

const server = buildControlServer();
const client = new Client({ name: "audit-scope-test", version: "0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const query = async (args: Record<string, unknown>): Promise<{ entries: AuditWireEntry[]; filter: { org?: string } }> => {
  const res = await client.callTool({ name: "audit_query", arguments: args });
  return JSON.parse((res.content as { type: string; text: string }[])[0].text);
};

{
  const tools = await client.listTools();
  const audit = tools.tools.find((t) => t.name === "audit_query");
  ok("audit_query is registered", audit !== undefined);
  const props = (audit!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  ok("🔴 audit_query's input schema no longer advertises `org` — a model cannot ask for another tenant", !("org" in props));
  ok("control: the other filters are still advertised", "action" in props && "since" in props && "limit" in props);
}

{
  const view = await query({ limit: 1000 });
  ok("the read returns rows", view.entries.length > 0);
  ok("🔴 every row a bare call returns belongs to the deployment's own org", view.entries.every((e) => e.org === deploymentOrg()));
  ok("🔴 the foreign org's judge operator row is not among them", !view.entries.some((e) => e.org === FOREIGN_ORG));
  ok(
    "control: the deployment's own judge operator row IS returned — the filter narrows by org, it does not hide the action",
    view.entries.some((e) => e.action === "approval.judge.contradicted" && e.principalId === "U_HOME_OPS"),
  );
  ok("the echoed filter names the deployment org", view.filter.org === deploymentOrg());
}

{
  const view = await query({ action: "approval.judge.contradicted", limit: 1000 });
  ok("the action filter still finds the home org's operator row", view.entries.length === 1 && view.entries[0]!.principalId === "U_HOME_OPS");
  ok(
    "🔴 and the foreign org's admin-rearm — the permissive act — never reaches the control read",
    !view.entries.some((e) => (e.detail as { humanAction?: unknown } | undefined)?.humanAction === "admin-rearm"),
  );
}

{
  let answered = true;
  let entries: AuditWireEntry[] = [];
  try {
    entries = (await query({ org: FOREIGN_ORG, limit: 1000 })).entries;
  } catch {
    answered = false;
  }
  ok("🔴 naming a foreign org returns none of its rows", !entries.some((e) => e.org === FOREIGN_ORG));
  if (answered) {
    ok("…and the call is answered about THIS deployment instead — the argument is ignored, not honoured", entries.length > 0 && entries.every((e) => e.org === deploymentOrg()));
  } else {
    ok("…because the call was refused outright, which is the other non-widening answer", entries.length === 0);
  }
}

{
  const { readAudit } = await import("../agent/audit/audit.js");
  const foreign = await readAudit({ org: FOREIGN_ORG, limit: 1000 });
  ok("fixture control: the foreign org's rows exist in the shared store", foreign.length === 2);
  ok(
    "fixture control: including its judge operator row — the exact row the control read must not surface",
    foreign.some((r) => r.action === "approval.judge.contradicted"),
  );
}

await client.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ control audit read is org-pinned: ${n} assertions passed\n`);
