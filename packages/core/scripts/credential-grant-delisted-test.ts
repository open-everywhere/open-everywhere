process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import assert from "node:assert/strict";

import { registerGrantBorrowTransport, runGrantedCall, type GrantCallContext } from "../agent/access/credential-grant-broker.js";
import { _resetGrantBorrowTransportsForTest } from "../agent/access/grant-borrow-transport-registry.internal.js";
import { credentialGrantConnectors, isCredentialGrantConnector } from "../agent/access/credential-grant.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { credentialGrantRefusalMessage, type CredentialGrantRefusal, type CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";

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
const WS = "T-OPE1457";
const OWNER = `slack/${WS}/U-owner`;
const REQUESTER = `slack/${WS}/U-req`;
const SCOPE = "session-1457";
const NOW = Date.now();
const store = getOperationalStore();

const DELISTED = "linear";
const LISTED = credentialGrantConnectors()[0];

ok(!isCredentialGrantConnector(DELISTED), `the fixture's "${DELISTED}" really is outside CREDENTIAL_GRANT_ROLES`);
ok(LISTED !== undefined && isCredentialGrantConnector(LISTED), "…and the control connector really is inside it");

const sent: string[] = [];
_resetGrantBorrowTransportsForTest();

selectConnectorTransport({ connector: DELISTED, directUrl: "https://mcp.linear.app/mcp", provider: DELISTED });
registerGrantBorrowTransport(
  DELISTED,
  async (call) => {
    sent.push(`${DELISTED}:${call.mcpTool}`);
    return { blocks: [] };
  },
  "test:credential-grant-delisted (a provider bundle's own transport)",
);
registerGrantBorrowTransport(
  LISTED as string,
  async (call) => {
    sent.push(`${LISTED}:${call.mcpTool}`);
    return { blocks: [] };
  },
  "test:credential-grant-delisted (the control)",
);

const ctx = (): GrantCallContext => ({
  nowMs: NOW,
  org: ORG,
  platform: "slack",
  requesterPrincipalId: REQUESTER,
  scopeKey: SCOPE,
  workspace: WS,
});

const row = (id: string, connector: string, mode: "once" | "session", status: CredentialGrantRow["status"] = "active"): CredentialGrantRow => ({
  askId: `ask-${id}`,
  connector,
  createdAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
  id,
  mode,
  ownerPrincipalId: OWNER,
  ownerSlug: "rowan",
  purpose: "draft the Q3 summary",
  frozenArgs: { page: "abc123" },
  inputSchema: { properties: { page: { const: "abc123", type: "string" } }, required: ["page"], type: "object" },
  mcpTool: `${connector}-fetch`,
  requesterPrincipalId: REQUESTER,
  resource: `Launch page — ${connector}-fetch({page:abc123})`,
  scopeKey: SCOPE,
  status,
  tier: "read",
  toolName: `grant__rowan_${connector}__${connector}_fetch_launch_page`,
  verb: `${connector}_fetch`,
});

await store.addCredentialGrant(ORG, row("g-delisted-once", DELISTED, "once"));
await store.addCredentialGrant(ORG, row("g-delisted-session", DELISTED, "session"));
await store.addCredentialGrant(ORG, row("g-delisted-revoked", DELISTED, "session", "revoked"));
await store.addCredentialGrant(ORG, row("g-listed", LISTED as string, "session"));

async function refusedGates(): Promise<string[]> {
  const rows = await readAudit({ action: "grant.refused", org: ORG });
  return rows.map((r) => String((r.detail as Record<string, unknown> | undefined)?.["gate"] ?? "none")).sort();
}

console.log("1. a grant for a connector the reviewed list does not name refuses at dispatch:");
{
  const refused = await runGrantedCall("g-delisted-once", {}, ctx());
  eq(refused.ok ? "OK" : refused.refused, "connector_delisted", "🔴 the broker refuses by its OWN named gate");
  ok(
    !refused.ok && refused.message !== credentialGrantRefusalMessage(row("g-delisted-once", DELISTED, "once"), "no_transport"),
    "…and the model reads the PERMISSION sentence, not the missing-transport one — a transport is registered and reachable",
  );
  const second = await runGrantedCall("g-delisted-session", {}, ctx());
  eq(second.ok ? "OK" : second.refused, "connector_delisted", "a session-mode row refuses the same way: the arm is a property of the CONNECTOR, not the row");
}

console.log("2. the refusal precedes the transport lookup and the burn:");
{
  eq(sent, [], "🔴 the foreign transport was never reached — the credential was not spent outside the MCP call fence");
  eq((await store.getCredentialGrant(ORG, "g-delisted-once"))?.status, "active", "…and the once-mode row is NOT burned");
}

console.log("3. each refusal lands a grant.refused row naming the gate:");
{
  eq(await refusedGates(), ["connector_delisted", "connector_delisted"], "one row per refusal, each carrying the gate that produced it");
  const rows = await readAudit({ action: "grant.refused", org: ORG });
  const delisted = rows.find((r) => (r.detail as Record<string, unknown>)["gate"] === "connector_delisted");
  eq((delisted?.detail as Record<string, unknown>)["owner"], OWNER, "…the row names the owner whose credential was not spent");
  eq(delisted?.principalId, REQUESTER, "…and the requester who asked, so the hazard is legible in the log");
}

console.log("3b. an ADMITTED connector with no connection still refuses no_transport:");
{
  const noConnection = await runGrantedCall("g-listed", {}, ctx());
  eq(noConnection.ok ? "OK" : noConnection.refused, "no_transport", "🔴 the connection arm of `no_transport` is untouched — the new check narrows the LIST, not the send path");
  ok(
    !noConnection.ok && noConnection.message.includes("The grant itself is valid"),
    "…and its copy still says the missing half is this deployment's, not the owner's",
  );
  eq(sent, [], "…and it reached no transport either");
}

selectConnectorTransport({ connector: LISTED as string, directUrl: "https://mcp.notion.com/mcp", provider: LISTED as string });

console.log("4. NEGATIVE CONTROL — the same fixture on a LISTED connector spends the grant:");
{
  const result = await runGrantedCall("g-listed", {}, ctx());
  eq(result.ok, true, "🔴 a granted call on a connector the list names COMPLETES — the arm narrows the list, never the plane");
  eq(sent, [`${LISTED}:${LISTED}-fetch`], "…and its transport was reached exactly once, dialling the vendor tool the row names");
}

console.log("5. the row's own state is judged first, so a revoked row still reads revoked:");
{
  const revoked = await runGrantedCall("g-delisted-revoked", {}, ctx());
  eq(revoked.ok ? "OK" : revoked.refused, "revoked", "a REVOKED row for a de-listed connector refuses `revoked` — the new arm does not relabel the row's own truth");
  eq(sent.length, 1, "…and it reached no transport either");
}

console.log("6. the refusal copy names the boundary and the vocabulary stays exhaustive:");
{
  const sample = row("g-copy", DELISTED, "session");
  const message = credentialGrantRefusalMessage(sample, "connector_delisted");
  ok(message.includes("no longer admits credential grants"), "the copy names the boundary: this deployment's own permission, not a missing part");
  ok(message.includes("rowan"), "…and names the owner whose credential stayed unspent");
  ok(message.includes("stays as"), "…and says the grant row itself is unchanged, which is true — nothing revoked it");
  ok(message.includes("Do not retry"), "…and tells the model not to loop on it");
  const every = [
    "revoked",
    "expired",
    "burned",
    "out_of_scope",
    "no_lent_tool",
    "no_transport",
    "owner_unresolvable",
    "unverified_requester",
    "unattended_wake",
    "halted",
    "connector_delisted",
  ] as const satisfies readonly CredentialGrantRefusal[];
  type Missing = Exclude<CredentialGrantRefusal, (typeof every)[number]>;
  const noneMissing: Missing extends never ? true : Missing = true;
  ok(noneMissing === true, "🔴 the list holds every name in the union — checked by the compiler, not by this line");
  ok(
    every.every((reason) => credentialGrantRefusalMessage(sample, reason).length > 0),
    "every name in the vocabulary has copy — the switch is exhaustive",
  );
  eq(new Set(every.map((r) => credentialGrantRefusalMessage(sample, r))).size, every.length, "…and no two names share a sentence");
}

console.log(`\ncredential-grant-delisted: ${n} assertions passed.`);
