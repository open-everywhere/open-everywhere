import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();


const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-dm-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
overrideSettingsForTest({ connectors: { dmOnly: true } });
_setDeploymentIdentityForTest({ org: undefined });
process.env.OE_PLATFORM = "slack";

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
registerConfig({
  loadConnectorCredentials: () => [
    { connector: "notion", allows: ["api-key"], credentials: [{ id: "team", type: "api-key", secretRef: "NOTION_TEAM", broker: "env" }] },
    { connector: "personal-only", allows: ["api-key"], credentials: [{ id: "mine", type: "api-key", secretRef: "MINE", broker: "env" }] },
  ],
  loadBundles: () => [
    defineBundle({ name: "svc", connectors: [{ name: "notion", credential: "team", contentOrigin: "external" }] }),
    defineBundle({ name: "personal", connectors: [{ name: "notion", credential: "team", contentOrigin: "external" }] }),
    defineBundle({ name: "personal-universe", connectors: [{ name: "personal-only", credential: "mine", contentOrigin: "external" }] }),
  ],
  loadBindings: () => [
    defineBinding({ bundle: "svc", scope: { level: "org" } }),
    defineBinding({ bundle: "personal", scope: { level: "principal", principal: "slack/T_TEAM/U_caller" } }),
    defineBinding({ bundle: "personal-universe", scope: { level: "principal", principal: "slack/T_TEAM/U_caller" } }),
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
overrideSettingsForTest({ connectors: { dmOnly: true } });
ok(scope.connectorDmOnlyEnabled(), "OE_CONNECTOR_DM_ONLY empty -> wall still ON");
overrideSettingsForTest({ connectors: { dmOnly: false } });
ok(!scope.connectorDmOnlyEnabled(), 'OE_CONNECTOR_DM_ONLY="0" -> wall off (explicit disarm only)');
overrideSettingsForTest({ connectors: { dmOnly: true } });

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
  overrideSettingsForTest({ connectors: { dmOnly: false } });
  const msg = await refusal("notion", channelAuth);
  ok(msg === "", "OE_CONNECTOR_DM_ONLY=0 -> a granted channel surface passes (legacy test-deployment path)");
  const rows = await readAudit({ org: "default", action: "connector.use" });
  ok(rows.some((r) => r.detail?.mode === "channel"), "disarmed-wall channel pass is still audited as connector.use");
  const denied = await refusal("not-a-connection", channelAuth);
  ok(denied.includes("not granted"), "disarming the wall does NOT disarm the grant gate");
  overrideSettingsForTest({ connectors: { dmOnly: true } });
}

{
  overrideSettingsForTest({ connectors: { dmOnly: true, opTiering: true } });
  ok(scope.connectorDmOnlyEnabled(), "the wall is still UP for this block — the carve-out is not the escape hatch");

  const before = (await readAudit({ org: "default", action: "connector.use" })).length;
  const msg = await refusal("notion", channelAuth);
  ok(msg === "", "opTiering armed -> a CHANNEL surface holding a service grant passes the wall");
  const rows = await readAudit({ org: "default", action: "connector.use" });
  ok(rows.length === before + 1, "the carve-out pass wrote one connector.use audit row");
  const carved = rows.filter((r) => r.detail?.grant === "work-surface");
  ok(carved.length === 1, "exactly one row names the tier that admitted it (grant=work-surface)");
  ok(carved[0].detail?.mode === "channel", "that row still carries the resolved mode");
  ok(
    rows.filter((r) => r.detail?.mode === "dm").every((r) => r.detail?.grant === undefined),
    "a DM pass carries NO work-surface stamp — the two tiers are distinguishable in the log",
  );

  const channelWorkerAuth = slackAuth({ channel_id: "C_CHAN", channel_type: "channel", user_id: "U_caller", oe_grain: "task" });
  ok((await refusal("notion", channelWorkerAuth)) === "", "a CHANNEL-spawned worker reaches the domain work grant (the OPE-913 shape)");

  const personalFromChannel = await refusal("personal-only", channelAuth);
  ok(personalFromChannel.includes("not granted"), "a PERSONAL-only connector is still unreachable from a channel with the carve-out armed");
  ok(!personalFromChannel.includes("DM-only"), "and it fails at the GRANT gate, not the wall — the personal universe never resolved at all");
  ok((await refusal("personal-only", dmAuth)) === "", "the same personal connector still works in its owner's DM");

  ok((await refusal("not-a-connection", channelAuth)).includes("not granted"), "the carve-out does NOT disarm the grant gate");

  overrideSettingsForTest({ connectors: { dmOnly: true, opTiering: false } });
  const refused = await refusal("notion", channelAuth);
  ok(refused.includes("DM-only"), "opTiering OFF -> the same channel call is refused by the wall again");
  ok(refused.includes("opTiering"), "the refusal names the setting a deployment must arm to hold a work grant");
  overrideSettingsForTest({ connectors: { dmOnly: true, opTiering: false } });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ connector-dm: ${passed} assertions passed`);
