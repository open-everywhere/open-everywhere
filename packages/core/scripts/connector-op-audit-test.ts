import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-op-audit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_PLATFORM = "slack";
delete process.env.OE_ORG;

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

const handler = (hookMod.default as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["action.result"];

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

function ev(result: unknown, status = "success") {
  return { type: "action.result", data: { status, result } };
}

await handler(ev({ kind: "tool-result", toolName: "notion__create_page", isError: false }), ctx);
{
  const rows = await readAudit({ org: "default", action: "connector.op" });
  ok(rows.length === 1, "one connector.op row for a connector write");
  ok(rows[0].detail?.connection === "notion" && rows[0].detail?.op === "create_page", "row carries connection + op (ids only)");
  ok(rows[0].detail?.tier === "gate:member", "write op tier = gate:member (the plane made visible)");
  ok(rows[0].detail?.status === "success", "row carries the outcome status");
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
  ok(errRow?.detail?.isError === true && errRow?.detail?.status === "error", "an errored op row carries isError + status");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ connector-op-audit: ${passed} assertions passed`);
