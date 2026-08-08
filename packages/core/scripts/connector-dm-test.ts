
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();


const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-dm-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_CONNECTOR_DM_ONLY;
delete process.env.OE_ORG;
process.env.OE_PLATFORM = "slack";

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
registerConfig({
  loadBundles: () => [
    defineBundle({ name: "svc", connectors: ["notion"] }),
    defineBundle({ name: "personal", connectors: ["notion"] }),
  ],
  loadBindings: () => [
    defineBinding({ bundle: "svc", scope: { level: "org" } }),
    defineBinding({ bundle: "personal", scope: { level: "principal", principal: "slack/T_TEAM/U_caller" } }),
  ],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const scope = await import("../agent/access/connector-scope.js");
const { readAudit } = await import("../agent/audit/audit.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

function slackAuth(attrs: Record<string, string>) {
  const p = {
    principalType: "service",
    principalId: attrs.user_id,
    authenticator: "slack",
    attributes: { team_id: "T_TEAM", is_private: "false", ...attrs },
  };
  return { current: p, initiator: p };
}
const channelAuth = slackAuth({ channel_id: "C_CHAN", channel_type: "channel", user_id: "U_caller" });
const dmAuth = slackAuth({ channel_id: "D_DM", channel_type: "im", user_id: "U_caller" });
const mpimAuth = slackAuth({ channel_id: "G_MPIM", channel_type: "mpim", user_id: "U_caller" });
const dmWorkerAuth = slackAuth({ channel_id: "D_DM", channel_type: "im", user_id: "U_caller", oe_grain: "task" });

async function refusal(name: string, auth: unknown): Promise<string> {
  try {
    await scope.assertConnectorGranted(name, auth as never);
    return "";
  } catch (e) {
    if (!(e instanceof scope.ConnectorScopeError)) throw e;
    return e.message;
  }
}

ok(scope.connectorDmOnlyEnabled(), "OE_CONNECTOR_DM_ONLY unset -> wall ON (security default)");
process.env.OE_CONNECTOR_DM_ONLY = "";
ok(scope.connectorDmOnlyEnabled(), "OE_CONNECTOR_DM_ONLY empty -> wall still ON");
process.env.OE_CONNECTOR_DM_ONLY = "0";
ok(!scope.connectorDmOnlyEnabled(), 'OE_CONNECTOR_DM_ONLY="0" -> wall off (explicit disarm only)');
delete process.env.OE_CONNECTOR_DM_ONLY;

{
  const msg = await refusal("notion", channelAuth);
  ok(msg.includes("DM-only"), "granted CHANNEL surface -> refused, error names the DM-only rule");
  ok(msg.includes('mode "channel"'), "refusal names the resolved mode");
  const rows = await readAudit({ org: "default", action: "connector.refused" });
  ok(rows.length === 1, "channel refusal wrote one connector.refused audit row");
  ok(rows[0].detail?.reason === "dm_only" && rows[0].detail?.connection === "notion" && rows[0].detail?.mode === "channel", "refusal row carries reason=dm_only + connection + mode (ids only)");
  ok(rows[0].platform === "slack" && rows[0].surface === "C_CHAN" && rows[0].principalId === "U_caller", "refusal row is who/where stamped from the binding");
}

{
  const msg = await refusal("notion", mpimAuth);
  ok(msg.includes("DM-only"), "granted MPIM surface -> refused (positively-dm or nothing)");
}

{
  const msg = await refusal("notion", dmAuth);
  ok(msg === "", "DM surface with a dm:<principal> grant -> getToken gate passes");
  const rows = await readAudit({ org: "default", action: "connector.use" });
  ok(rows.length === 1, "the DM pass wrote one connector.use audit row");
  ok(rows[0].detail?.connection === "notion" && rows[0].detail?.mode === "dm", "connector.use row carries connection + mode");
}

{
  const msg = await refusal("notion", dmWorkerAuth);
  ok(msg === "", "a DM-origin task worker (parent DM attributes inherited verbatim) passes the wall");
}

{
  const msg = await refusal("notion", { current: null, initiator: null });
  ok(msg.includes("could not resolve"), "no auth identity -> refused fail-closed (pre-wall, unchanged)");
  const rows = await readAudit({ org: "default", action: "connector.refused" });
  const unresolved = rows.filter((r) => r.detail?.reason === "unresolved_surface");
  ok(unresolved.length === 1, "unresolvable surface refusal is audited (reason=unresolved_surface)");
  ok(unresolved[0].platform === "unknown" && unresolved[0].workspace === "unknown", 'unattributable refusal row lands with "unknown" stamps');
}

{
  const msg = await refusal("not-a-connection", dmAuth);
  ok(msg.includes("not granted"), "an UNGRANTED connection is refused by the grant gate even in a DM");
  const rows = await readAudit({ org: "default", action: "connector.refused" });
  ok(rows.some((r) => r.detail?.reason === "ungranted" && r.detail?.connection === "not-a-connection"), "ungranted refusal is audited (reason=ungranted)");
}

{
  process.env.OE_CONNECTOR_DM_ONLY = "0";
  const msg = await refusal("notion", channelAuth);
  ok(msg === "", "OE_CONNECTOR_DM_ONLY=0 -> a granted channel surface passes (legacy test-deployment path)");
  const rows = await readAudit({ org: "default", action: "connector.use" });
  ok(rows.some((r) => r.detail?.mode === "channel"), "disarmed-wall channel pass is still audited as connector.use");
  const denied = await refusal("not-a-connection", channelAuth);
  ok(denied.includes("not granted"), "disarming the wall does NOT disarm the grant gate");
  delete process.env.OE_CONNECTOR_DM_ONLY;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ connector-dm: ${passed} assertions passed`);
