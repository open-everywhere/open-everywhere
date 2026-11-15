process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import assert from "node:assert/strict";

import { defineBundle, type Bundle } from "../agent/access/bundle.js";
import { registerConfig } from "../agent/access/config.js";
import { registerGrantBorrowTransport, runGrantedCall, type GrantCallContext } from "../agent/access/credential-grant-broker.js";
import { credentialGrantConnectors, credentialGrantMintVerdict, type GrantMintInput } from "../agent/access/credential-grant.js";
import { _resetGrantBorrowTransportsForTest } from "../agent/access/grant-borrow-transport-registry.internal.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import type { CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "acme";
const WS = "T-OPE2664";
const OWNER = `slack/${WS}/U-owner`;
const REQUESTER = `slack/${WS}/U-req`;
const SCOPE = "session-2664";
const NOW = Date.now();
const CONNECTOR = credentialGrantConnectors()[0] as string;
ok(CONNECTOR !== undefined, "fixture: the reviewed grant list names a connector");

let bundles: readonly Bundle[] = [];
registerConfig({
  loadBundles: () => bundles,
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
const NEVER_ALL: readonly Bundle[] = [defineBundle({ name: "grant-never", connectorOps: [{ connector: CONNECTOR, never: ["*"] }] })];

const mintInput = (mcpTool: string): GrantMintInput => ({
  borrow: { mcpTool, rowId: "11112222-3333-4444-5555-666677778888", takenToolNames: [], targetLabel: "Quarterly report" },
  connector: CONNECTOR,
  domainGrantsConnector: true,
  liveAsk: undefined,
  liveGrant: undefined,
  ownerHandle: "Ada Lovelace",
  ownerPrincipalId: OWNER,
  requesterPrincipalId: REQUESTER,
});
const TOOL = `${CONNECTOR}-fetch`;
const control = credentialGrantMintVerdict(mintInput(TOOL));
ok(control.ok, "mint control: a read tool mints while the config names nothing");
bundles = NEVER_ALL;
const refused = credentialGrantMintVerdict(mintInput(TOOL));
eq(refused.ok ? "MINTED" : refused.reason, "never_tier", "🔴 mint: a config `never` entry refuses the grant by its own name");
bundles = [];

const sent: string[] = [];
_resetGrantBorrowTransportsForTest();
selectConnectorTransport({ connector: CONNECTOR, directUrl: "https://mcp.example.invalid/mcp", provider: CONNECTOR });
registerGrantBorrowTransport(
  CONNECTOR,
  async (call) => {
    sent.push(call.mcpTool);
    return { blocks: [] };
  },
  "test:credential-grant-never-tier",
);
const store = getOperationalStore();
const row = (id: string): CredentialGrantRow => ({
  askId: `ask-${id}`,
  connector: CONNECTOR,
  createdAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
  id,
  mode: "once",
  ownerPrincipalId: OWNER,
  ownerSlug: "ada",
  purpose: "draft the Q3 summary",
  frozenArgs: { page: "abc123" },
  inputSchema: { properties: { page: { const: "abc123", type: "string" } }, required: ["page"], type: "object" },
  mcpTool: TOOL,
  requesterPrincipalId: REQUESTER,
  resource: `Launch page — ${TOOL}({page:abc123})`,
  scopeKey: SCOPE,
  status: "active",
  tier: "read",
  toolName: `grant__ada_${CONNECTOR}__${CONNECTOR}_fetch_launch_page`,
  verb: `${CONNECTOR}_fetch`,
});
const ctx: GrantCallContext = { nowMs: NOW, org: ORG, platform: "slack", requesterPrincipalId: REQUESTER, scopeKey: SCOPE, workspace: WS };
await store.addCredentialGrant(ORG, row("g-never"));
bundles = NEVER_ALL;
const blocked = await runGrantedCall("g-never", {}, ctx);
eq(blocked.ok ? "OK" : blocked.refused, "never_tier", "🔴 broker: a config `never` entry added after the mint refuses the live grant at dispatch");
ok(!blocked.ok && blocked.message.includes("never allowed") && blocked.message.includes("not waiting for approval"), "broker: the refusal says never allowed, not pending");
eq(sent.length, 0, "broker: nothing was sent to the vendor");
bundles = [];
const after = await runGrantedCall("g-never", {}, ctx);
eq(after.ok ? "OK" : after.refused, "OK", "broker control: with the entry gone the same row dispatches");
eq(sent.length, 1, "broker control: …and the vendor transport really is reachable, so the zero above is not vacuous");

registerConfig({
  loadBundles: () => {
    throw new Error("simulated unreadable config");
  },
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
const unreadableMint = credentialGrantMintVerdict(mintInput(TOOL));
eq(unreadableMint.ok ? "MINTED" : unreadableMint.reason, "never_tier_config_unavailable", "🔴 mint: an unreadable config refuses, under its own reason, not as a never-allowed tool");
await store.addCredentialGrant(ORG, row("g-unreadable"));
const unreadableCall = await runGrantedCall("g-unreadable", {}, ctx);
eq(unreadableCall.ok ? "OK" : unreadableCall.refused, "never_tier_config_unavailable", "🔴 broker: an unreadable config refuses at dispatch, under its own reason");
ok(!unreadableCall.ok && unreadableCall.message.includes("could not be read") && !unreadableCall.message.includes("never allowed"), "broker: the text tells the operator to fix the configuration, not that the tool is banned");
eq(sent.length, 1, "broker: the unreadable-config refusal sent nothing");

console.log(`✓ credential-grant-never-tier: ${n} assertions`);
