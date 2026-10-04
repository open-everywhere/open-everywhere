import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import "./_register-test-config.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-control-audit-scope-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "home-org" });
const FOREIGN_ORG = "other-tenant";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer } = await import("../agent/control/server.js");
const { appendAudit } = await import("../agent/audit/audit.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");

const ENG_SURFACE = "C_ENG";
const PAY_SURFACE = "C_PAY";
const HOME_PLATFORM = "slack";
const HOME_WORKSPACE = "T_HOME";
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "eng", reach: [`${HOME_PLATFORM}/${HOME_WORKSPACE}/${ENG_SURFACE}`] }),
    defineDomain({ name: "payments", reach: [`${HOME_PLATFORM}/${HOME_WORKSPACE}/${PAY_SURFACE}`] }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

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

await appendAudit({ org: deploymentOrg(), platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, surface: ENG_SURFACE, principalId: "U_ENG", action: "memory.write", detail: { note: "eng row" } });
await appendAudit({
  org: deploymentOrg(),
  platform: HOME_PLATFORM,
  workspace: HOME_WORKSPACE,
  surface: PAY_SURFACE,
  principalId: "U_PAY_OPS",
  action: "approval.judge.contradicted",
  detail: { domain: "payments", humanAction: "admin-disarm", route: "control" },
});

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
  ok(
    "the action filter still finds the home org's operator rows",
    view.entries.length === 2 && view.entries.every((e) => e.org === deploymentOrg()) && view.entries.some((e) => e.principalId === "U_HOME_OPS"),
  );
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

const domainServer = buildControlServer({ roles: ["domain:eng"] });
const domainClient = new Client({ name: "audit-scope-domain-test", version: "0" });
const [domainClientTransport, domainServerTransport] = InMemoryTransport.createLinkedPair();
await domainServer.connect(domainServerTransport);
await domainClient.connect(domainClientTransport);

const rawCall = async (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, text: (res.content as { type: string; text: string }[])[0]!.text };
};
const REFUSAL = "forbidden: no role covers";
const ENG_TRIPLE = { platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, surface: ENG_SURFACE };
const PAY_TRIPLE = { platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, surface: PAY_SURFACE };

{
  const view = await query({ limit: 1000 });
  ok("🔴 an admin's bare audit_query still reaches the eng container's row", view.entries.some((e) => e.principalId === "U_ENG"));
  ok("🔴 …and the payments container's judge row in the same answer — admin stays org-wide", view.entries.some((e) => e.principalId === "U_PAY_OPS"));
  const preview = await rawCall(client, "access_preview", { platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, channel: PAY_SURFACE });
  ok("🔴 an admin previews a scope in ANY domain", !preview.isError && (JSON.parse(preview.text) as { routing: { domain: string | null } }).routing.domain === "payments");
}

{
  const own = await rawCall(domainClient, "audit_query", { ...ENG_TRIPLE, limit: 1000 });
  ok("🔴 a domain:eng token IS answered for its own container — the gate scopes, it does not lock out", !own.isError);
  const rows = (JSON.parse(own.text) as { entries: AuditWireEntry[] }).entries;
  ok("…and the answer really carries that container's row", rows.some((e) => e.principalId === "U_ENG"));
  ok("🔴 …and carries no row from the payments container it does not hold", !rows.some((e) => e.principalId === "U_PAY_OPS"));

  const other = await rawCall(domainClient, "audit_query", { ...PAY_TRIPLE, limit: 1000 });
  ok("🔴 a domain:eng token naming the payments container is REFUSED", other.isError && other.text.includes(REFUSAL));
  ok(
    "…and the refusal names the container it would not cover, so an operator can read what was asked",
    other.text.includes(`${HOME_PLATFORM}/${HOME_WORKSPACE}/${PAY_SURFACE}`),
  );
  ok("…and it leaks no row of that container in the refusal text", !other.text.includes("U_PAY_OPS"));

  const unscoped = await rawCall(domainClient, "audit_query", { limit: 1000 });
  ok("🔴 an UNSCOPED audit_query is org-wide, so a domain token is refused — the overrides_list posture", unscoped.isError && unscoped.text.includes(REFUSAL));
  ok("…and the refusal says the ask was org-wide", unscoped.text.includes("(org-wide)"));

  const partial = await rawCall(domainClient, "audit_query", { workspace: HOME_WORKSPACE, surface: ENG_SURFACE, limit: 1000 });
  ok("🔴 a PARTIAL triple (no platform) is treated as org-wide and refused, not resolved loosely", partial.isError && partial.text.includes(REFUSAL));
}

{
  const own = await rawCall(domainClient, "access_preview", { platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, channel: ENG_SURFACE });
  ok("🔴 a domain:eng token previews a scope in its own domain", !own.isError);
  ok(
    "…and the preview really answers about that scope — the gate admitted the surface the answer is about",
    (JSON.parse(own.text) as { routing: { domain: string | null } }).routing.domain === "eng",
  );

  const other = await rawCall(domainClient, "access_preview", { platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, channel: PAY_SURFACE });
  ok("🔴 a domain:eng token previewing the payments channel is REFUSED", other.isError && other.text.includes(REFUSAL));
  ok("…and no resolved access leaks in the refusal text", !other.text.includes("instructionStack"));

  const bare = await rawCall(domainClient, "access_preview", {});
  ok("🔴 a bare access_preview is gated on the view's DEFAULT triple, and a domain token is refused", bare.isError && bare.text.includes(REFUSAL));
  ok("…and the refusal names that default triple, proving gate and answer read one scope", bare.text.includes("local/dev/default"));

  const dm = await rawCall(domainClient, "access_preview", { platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, channel: ENG_SURFACE, mode: "dm", principalId: "U_PAY_OPS" });
  ok("🔴 a domain:eng token is REFUSED a dm preview, even naming a channel inside its own domain", dm.isError && dm.text.includes(REFUSAL));
  ok("…and the refusal calls the ask org-wide, not a surface it failed to cover", dm.text.includes("(org-wide)"));

  const adminDm = await rawCall(client, "access_preview", { platform: HOME_PLATFORM, workspace: HOME_WORKSPACE, channel: ENG_SURFACE, mode: "dm", principalId: "U_PAY_OPS" });
  ok("🔴 an admin IS answered the same dm preview", !adminDm.isError);
  ok(
    "…and that answer really is about the PERSON, which is why no domain role may buy it",
    (JSON.parse(adminDm.text) as { scopeKey: string }).scopeKey === "dm:U_PAY_OPS",
  );
}

await domainClient.close();
await client.close();
await removeTempDir(dir);
console.log(`\n✓ control audit read is org-pinned and role-scoped: ${n} assertions passed\n`);
