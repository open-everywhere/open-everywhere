process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  _resetGrantTransportsForTest,
  registerGrantTransport,
  runGrantedCall,
  type GrantCallContext,
} from "../agent/access/credential-grant-broker.js";
import { _resetGrantableVerbsForTest, registerGrantableVerb } from "../agent/access/credential-grant.js";
import { currentJobWakePosture, markJobSession, setJobWakeEscalated } from "../agent/access/job-session-state.js";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import {
  credentialGrantRefusalMessage,
  type CredentialGrantRefusal,
  type CredentialGrantRow,
} from "../agent/operational/credential-grant-rows.js";

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
const WS = "T-OPE1094";
const OWNER = `slack/${WS}/U-owner`;
const REQUESTER = `slack/${WS}/U-req`;
const SCOPE = "session-1094";
const NOW = Date.now();
const store = getOperationalStore();

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

const sent: string[] = [];
_resetGrantTransportsForTest();
_resetGrantableVerbsForTest();
registerGrantableVerb({
  compose: (g) => ({ method: "GET", url: `https://api.notion.com/v1/blocks/${g.resource}/children` }),
  connector: "notion",
  describe: () => "read one page",
  inputSchema: { properties: {}, type: "object" },
  resourceKind: "page",
  tier: "read",
  verb: "read_page",
});
registerGrantTransport("notion", async (request) => {
  sent.push(request.url);
  return { blocks: [] };
});

const ctx = (): GrantCallContext => ({
  nowMs: NOW,
  org: ORG,
  platform: "slack",
  requesterPrincipalId: REQUESTER,
  scopeKey: SCOPE,
  workspace: WS,
});

const row = (id: string, mode: "once" | "session", status: CredentialGrantRow["status"] = "active"): CredentialGrantRow => ({
  askId: `ask-${id}`,
  connector: "notion",
  createdAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
  id,
  mode,
  ownerPrincipalId: OWNER,
  ownerSlug: "rowan",
  purpose: "draft the Q3 summary",
  requesterPrincipalId: REQUESTER,
  resource: "notion:page/abc123",
  scopeKey: SCOPE,
  status,
  tier: "read",
  verb: "read_page",
});

await store.addCredentialGrant(ORG, row("g-wake-once", "once"));
await store.addCredentialGrant(ORG, row("g-wake-session", "session"));
await store.addCredentialGrant(ORG, row("g-revoked", "session", "revoked"));
await store.addCredentialGrant(ORG, row("g-attended", "session"));

async function refusedGates(): Promise<string[]> {
  const rows = await readAudit({ action: "grant.refused", org: ORG });
  return rows.map((r) => String((r.detail as Record<string, unknown> | undefined)?.["gate"] ?? "none")).sort();
}

console.log("1. an unattended wake carrying a STAMPED requester still refuses, on wake posture alone:");
{
  const refused = await inSession(async () => {
    markJobSession();
    setJobWakeEscalated(false);
    ok(currentJobWakePosture() === "restricted", "the fixture really is a restricted job wake");
    return runGrantedCall("g-wake-once", {}, ctx());
  });
  eq(refused.ok ? "OK" : refused.refused, "unattended_wake", "🔴 the broker refuses by its OWN named gate, not by the OPE-675 attribution arm");
  eq(sent.length, 0, "…no vendor request was composed or sent");
  eq((await store.getCredentialGrant(ORG, "g-wake-once"))?.status, "active", "…and the once-mode grant is NOT burned: the refusal runs before the burn");
  ok(
    !refused.ok && refused.refused === "unattended_wake" && refused.message !== credentialGrantRefusalMessage(row("g-wake-once", "once"), "unverified_requester"),
    "…and the model reads the WAKE sentence, not the attribution one — the two boundaries are different facts",
  );

  const second = await inSession(async () => {
    markJobSession();
    setJobWakeEscalated(false);
    return runGrantedCall("g-wake-session", {}, ctx());
  });
  eq(second.ok ? "OK" : second.refused, "unattended_wake", "a session-mode grant on an unattended wake refuses the same way");
}

console.log("2. the wake refusal precedes every state check:");
{
  const revoked = await inSession(async () => {
    markJobSession();
    setJobWakeEscalated(false);
    return runGrantedCall("g-revoked", {}, ctx());
  });
  eq(
    revoked.ok ? "OK" : revoked.refused,
    "unattended_wake",
    "a REVOKED grant on an unattended wake refuses `unattended_wake` — the room is judged before the row",
  );
  const attended = await inSession(async () => {
    markJobSession();
    setJobWakeEscalated(true);
    return runGrantedCall("g-revoked", {}, ctx());
  });
  eq(attended.ok ? "OK" : attended.refused, "revoked", "…and the SAME row refuses `revoked` on an attended wake, so the state check still runs");
}

console.log("3. every refusal lands a grant.refused row naming the gate:");
{
  const gates = await refusedGates();
  eq(gates, ["revoked", "unattended_wake", "unattended_wake", "unattended_wake"], "one row per refusal so far, each carrying the gate that produced it");
  const rows = await readAudit({ action: "grant.refused", org: ORG });
  const wake = rows.find((r) => (r.detail as Record<string, unknown>)["gate"] === "unattended_wake");
  eq((wake?.detail as Record<string, unknown>)["owner"], OWNER, "…the row names the owner whose credential was not spent");
  eq(wake?.principalId, REQUESTER, "…and the requester the wake carried, so the hazard is legible in the log");
}

console.log("4. NEGATIVE CONTROL — an escalated wake on the SAME job session spends the grant:");
{
  const result = await inSession(async () => {
    markJobSession();
    setJobWakeEscalated(true);
    ok(currentJobWakePosture() === "unrestricted", "an escalated wake resolves unrestricted");
    return runGrantedCall("g-attended", {}, ctx());
  });
  eq(result.ok, true, "🔴 the granted call COMPLETES where a person is present — the arm narrows the wake, never the grant");
  eq(sent.length, 1, "…and the registered transport was reached exactly once");
  ok(sent[0]?.includes("abc123") === true, "…with the composed request the grant's own resource names");
}

console.log("5. NEGATIVE CONTROL — the unverified_requester refusal is untouched:");
{
  const noRequester = await inSession(async () => runGrantedCall("g-wake-session", {}, { ...ctx(), requesterPrincipalId: undefined }));
  eq(noRequester.ok ? "OK" : noRequester.refused, "unverified_requester", "an ordinary turn with no requester still refuses by the ATTRIBUTION name");
  const fireToday = await inSession(async () => {
    markJobSession();
    setJobWakeEscalated(false);
    return runGrantedCall("g-wake-session", {}, { ...ctx(), requesterPrincipalId: undefined });
  });
  eq(fireToday.ok ? "OK" : fireToday.refused, "unattended_wake", "a fire as dispatched TODAY now reads the wake boundary rather than the attribution one");
  eq(sent.length, 1, "…and neither refusal reached the transport");
}

console.log("6. the refusal copy names the boundary and the vocabulary stays exhaustive:");
{
  const message = credentialGrantRefusalMessage(row("g-copy", "session"), "unattended_wake");
  ok(message.includes("scheduler"), "the copy says who started the turn");
  ok(message.includes("nobody is in the room"), "…and names the boundary in words the model can act on");
  ok(message.includes("rowan"), "…and names the owner whose credential stayed unspent");
  ok(message.includes("Do not retry"), "…and tells the model not to loop on it");
  const every: readonly CredentialGrantRefusal[] = [
    "revoked",
    "expired",
    "burned",
    "out_of_scope",
    "no_transport",
    "owner_unresolvable",
    "unverified_requester",
    "unattended_wake",
  ];
  ok(
    every.every((reason) => credentialGrantRefusalMessage(row("g-copy", "session"), reason).length > 0),
    "every name in the vocabulary has copy — the switch is exhaustive",
  );
  ok(new Set(every.map((r) => credentialGrantRefusalMessage(row("g-copy", "session"), r))).size === every.length, "…and no two names share a sentence");
}

console.log(`\ncredential-grant-wake: ${n} assertions passed.`);
