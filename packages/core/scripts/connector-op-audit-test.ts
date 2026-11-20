import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";
import { setPlatformStandInForTest } from "../agent/identity/binding.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-op-audit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
setPlatformStandInForTest("slack");
_setDeploymentIdentityForTest({ org: undefined });

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const hookMod = await import("../agent/hooks/connector-audit.js");
const { readAudit } = await import("../agent/audit/audit.js");

const handler = (await import("./_hook-view.js")).callSettledHandler(hookMod.default);

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

const auth = {
  current: {
    principalType: "service",
    principalId: "U_caller",
    authenticator: "slack",
    attributes: { team_id: "T_TEAM", channel_id: "D_DM", channel_type: "im", user_id: "U_caller" },
  },
};
const ctx = { session: { auth }, channel: { kind: "slack" }, agent: { name: "oe" } };

// A tool result. `callSettledHandler` builds the v27 `call.settled` event and its view from it.
function ev(result: unknown, status = "success") {
  return { data: { status, result } };
}

await handler(ev({ kind: "tool-result", toolName: "notion__create_page", isError: false }), ctx);
{
  const rows = await readAudit({ org: "default", action: "connector.op" });
  ok(rows.length === 1, "one connector.op row for a connector write");
  ok(rows[0].detail?.connection === "notion" && rows[0].detail?.op === "create_page", "row carries connection + op (ids only)");
  ok(rows[0].detail?.tier === "gate:member", "write op tier = gate:member (the plane made visible)");
  ok(rows[0].detail?.status === "completed", "row carries the call's outcome");
}

await handler(ev({ kind: "tool-result", toolName: "notion__search", isError: false }), ctx);
{
  const rows = await readAudit({ org: "default", action: "connector.op" });
  ok(rows.length === 2, "a second connector.op row for the read");
  const read = rows.find((r) => r.detail?.op === "search");
  ok(read?.detail?.tier === "open", "read op tier = open");
}

await handler(ev({ kind: "tool-result", toolName: "reply", isError: false }), ctx);
ok((await readAudit({ org: "default", action: "connector.op" })).length === 2, "a bare authored tool (reply) writes NO connector.op row");

await handler(ev({ kind: "load-skill" }), ctx);
ok((await readAudit({ org: "default", action: "connector.op" })).length === 2, "a non-tool-result action writes NO connector.op row");

await handler(ev({ kind: "tool-result", toolName: "notion__update_page", isError: true }, "error"), ctx);
{
  const rows = await readAudit({ org: "default", action: "connector.op" });
  const errRow = rows.find((r) => r.detail?.op === "update_page");
  ok(errRow?.detail?.isError === true && errRow?.detail?.status === "failed", "an errored op row carries isError + the failed outcome");
}

await handler(ev({ kind: "tool-result", toolName: "grant__rowan_hale__read_page", isError: false }), ctx);
{
  const rows = await readAudit({ org: "default", action: "connector.op" });
  ok(rows.length === 3, "a credential-grant tool writes NO connector.op row");
  ok(rows.every((r) => r.detail?.connection !== "grant"), "...so no row ever carries the non-existent connection \"grant\"");
}

await handler(ev({ kind: "tool-result", toolName: "acme__server__search", isError: false }), ctx);
{
  const rows = await readAudit({ org: "default", action: "connector.op" });
  ok(rows.length === 4, "a three-segment PLUGIN connector name still writes its row -- the skip is namespace-keyed, not segment-count-keyed");
  ok(rows.some((r) => r.detail?.connection === "acme"), "...stamped with its real connection head");
}

{
  const { recordConnectorListing, registerMountedConnector } = await import("../agent/connections/connector-catalogue.js");
  const listed = (name: string) => ({ name, description: "", inputSchema: { type: "object" }, hasOutputSchema: false, annotations: { readOnlyHint: true } });
  registerMountedConnector("notion");
  recordConnectorListing("notion", [listed("frobnicate_widget"), listed("search")]);
  await handler(ev({ kind: "tool-result", toolName: "notion__frobnicate_widget", isError: false }), ctx);
  await handler(ev({ kind: "tool-result", toolName: "notion__search", isError: false }), ctx);
  const rows = await readAudit({ org: "default", action: "connector.op" });
  const hinted = rows.find((r) => r.detail?.op === "frobnicate_widget");
  ok(hinted?.detail?.opTier === "read" && hinted?.detail?.tier === "open", "🔴 a hint-read op audits at the read tier it ran at");
  ok(hinted?.detail?.opTierHint === "read" && hinted?.detail?.opTierHintDecided === true, "🔴 …and the row says the server's hint DECIDED it");
  ok(hinted?.detail?.opTierBasis === "unrecognised", "…with the name's own basis beside it (the verb heuristic abstained)");
  const agreed = rows.find((r) => r.detail?.op === "search" && r.detail?.opTierHint !== undefined);
  ok(agreed?.detail?.opTierHint === "read" && agreed?.detail?.opTierHintDecided === undefined, "an agreeing hint is recorded but is not marked as deciding");
}

await removeTempDir(tmp);
console.log(`✓ connector-op-audit: ${passed} assertions passed`);
