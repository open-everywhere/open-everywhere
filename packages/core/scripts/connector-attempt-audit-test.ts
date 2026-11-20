import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";
import { setPlatformStandInForTest } from "../agent/identity/binding.js";

/**
 * The ungranted-connector evidence on eve 1.x (`hooks/connector-audit.ts`, `call.requested`). A
 * connector mount's listing is a probe, so a surface without the grant is offered no op. The model
 * then reaches the connection only through the catalogue tools. Each attempt there on a connection
 * the surface does not hold writes one `connector.refused` row with reason `ungranted`: the evidence
 * the permission-proposal digest reads. Each 🔴 line names the behaviour whose removal turns it red.
 */

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-attempt-audit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.DATABASE_URL;
delete process.env.OE_PLATFORM;
setPlatformStandInForTest("slack");
_setDeploymentIdentityForTest({ org: undefined });

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
registerConfig({
  loadConnectorCredentials: () => [{ connector: "notion", allows: ["api-key"], credentials: [{ id: "team", type: "api-key", secretRef: "NOTION_TEAM", broker: "env" }] }],
  loadBundles: () => [defineBundle({ name: "svc", connectors: [{ name: "notion", credential: "team", contentOrigin: "external" }] })],
  loadBindings: () => [defineBinding({ bundle: "svc", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { registerMountedConnector, resetConnectorCatalogue } = await import("../agent/connections/connector-catalogue.js");
const hookMod = await import("../agent/hooks/connector-audit.js");
const { connectorAttemptsOf } = hookMod;
const { readAudit } = await import("../agent/audit/audit.js");
const { permissionEvidence, makeWindow } = await import("../agent/access/permission-evidence.js");
const { proposePermissionChanges } = await import("../agent/access/permission-proposal.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const handler = (hookMod.default as unknown as { events: Record<string, (event: unknown, ctx: unknown) => Promise<void>> }).events["call.requested"];
ok(typeof handler === "function", "🔴 connector-audit handles call.requested");

resetConnectorCatalogue();
registerMountedConnector("notion");
registerMountedConnector("linear");
const names = ["linear", "notion"];

// The parser: which mounted connections a requested call names.
const named = (name: string, input: unknown, list: readonly string[] = names) => connectorAttemptsOf({ capability: { name }, input }, list).join();
ok(named("eve__search", { query: "linear__" }) === "linear", "🔴 an eve__search for `<connection>__` names the connection");
ok(named("eve__search", { query: "open Linear issues" }) === "linear", "an eve__search with the connection as a word names it");
ok(named("eve__search", { query: "linear and notion" }) === "linear,notion", "an eve__search can name two connections");
ok(named("eve__search", { query: "linearity of notions" }) === "", "a word that only contains a connection name names nothing");
ok(named("eve__search", { query: "slack-as-you__" }, ["slack", "slack-as-you"]) === "slack-as-you", "🔴 a hyphenated connection does not name its prefix");
ok(named("eve__search", { query: "slack messages" }, ["slack", "slack-as-you"]) === "slack", "…and the shorter name still matches as its own word");
ok(named("eve__search", { query: "jira tickets" }) === "", "a search that names no mounted connection names nothing");
ok(named("eve__search", { query: "linear__" }, []) === "", "with no mounted connection nothing is named");
ok(named("eve__tool", { name: "linear__list_issues", input: {} }) === "", "an eve__tool call is not read: eve writes a fact for it only when it names an offered op");
ok(named("linear__list_issues", {}) === "", "an offered op that runs is not an attempt (the call-time gate audits it)");

// The hook: the real grant lookup decides whether a row is written.
const auth = {
  current: {
    principalType: "service",
    principalId: "U_caller",
    authenticator: "slack",
    attributes: { team_id: "T_TEAM", channel_id: "C_WORK", channel_type: "channel", is_private: "false", user_id: "U_caller" },
  },
};
const ctx = { session: { auth }, channel: { kind: "slack" }, agent: { name: "oe" } };
const requested = (callId: string, name: string, input: unknown) => ({ type: "call.requested", data: { callId, owner: { runId: "r1" }, capability: { kind: "tool", name }, input } });
const refused = async () => readAudit({ org: "default", action: "connector.refused" });

await handler(requested("c1", "eve__search", { query: "linear__" }), ctx);
await handler(requested("c2", "eve__search", { query: "linear issues" }), ctx);
{
  const rows = await refused();
  ok(rows.length === 2, `🔴 two searches for an ungranted connection write two connector.refused rows (got ${rows.length})`);
  ok(rows.every((r) => r.detail?.connection === "linear" && r.detail?.reason === "ungranted"), "🔴 each row names the connection with reason `ungranted`");
  ok(rows.every((r) => r.detail?.via === "eve__search"), "each row says the search made the attempt");
}

await handler(requested("c2", "eve__search", { query: "linear issues" }), ctx);
ok((await refused()).length === 2, "a replayed fact for the same call in this process writes no second row");

await handler(requested("c3", "eve__search", { query: "notion__" }), ctx);
ok((await refused()).length === 2, "🔴 an attempt on a connection the surface holds writes no refused row");
ok((await readAudit({ org: "default", action: "connector.use" })).length === 0, "the evidence path writes no connector.use row: no op ran");

await handler(requested("c5", "eve__search", { query: "weather" }), ctx);
ok((await refused()).length === 2, "a search that names no connection writes nothing");

// A personal-surface connection off its platform's DM is fenced, not ungranted: no evidence row.
{
  const { declarePersonalSurfaceConnection } = await import("../agent/connections/personal-surface-fence.js");
  registerMountedConnector("mine");
  declarePersonalSurfaceConnection("mine", "slack");
  await handler(requested("c6", "eve__search", { query: "mine__" }), ctx);
  ok((await refused()).filter((r) => r.detail?.connection === "mine").length === 0, "🔴 a channel search for a personal-surface connection writes no ungranted row");
}

// The digest reads the rows, and the proposal offers the grant.
{
  const rows = await refused();
  const ev = permissionEvidence(rows, [], makeWindow(1, new Date(Date.now() + 60_000)));
  const linear = ev.refusals.find((r) => r.kind === "connector-refused" && r.connection === "linear");
  ok(linear !== undefined && linear.kind === "connector-refused" && linear.ungranted === 2, "🔴 the permission evidence counts both ungranted attempts");
  ok(linear !== undefined && linear.kind === "connector-refused" && linear.ungrantedSearches === 2, "🔴 …and counts them as searches");
  const proposal = proposePermissionChanges(ev, "widen").find((p) => p.id === "widen:connector:ungranted:linear");
  ok(proposal !== undefined, "🔴 the proposal offers the linear grant");
  ok(proposal!.summary.includes("2 `eve__search` queries that named the connection (no operation ran)"), "🔴 the proposal says the attempts were searches");
  ok(!proposal!.summary.includes("refused by the credential gate"), "🔴 …and does not say an operation was refused");
  const mixed = permissionEvidence([...rows, { ts: rows[0]!.ts, action: "connector.refused", detail: { connection: "linear", reason: "ungranted" } }], [], makeWindow(1, new Date(Date.now() + 60_000)));
  const mixedProposal = proposePermissionChanges(mixed, "widen").find((p) => p.id === "widen:connector:ungranted:linear");
  ok(mixedProposal!.summary.startsWith("1 operation(s) refused by the credential gate and 2 `eve__search` queries"), "a gate refusal and searches are counted apart");
}

await removeTempDir(tmp);
console.log(`✓ connector-attempt-audit: ${passed} assertions passed`);
