// proves: admin.connector.clear_override, admin.routine.cancel, admin.session_grants.revoke, admin.spend.clear_limit, skill.delete

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import "./_register-test-config.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-control-write-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "default" });

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer, CONTROL_TOOL_NAMES } = await import("../agent/control/server.js");
const { CONTROL_WRITE_TOOL_NAMES } = await import("../agent/control/writes.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { effectiveCaps, applyCapOverrides } = await import("../agent/spend/caps.js");
const { applyConnectorOverrides } = await import("../agent/access/connector-scope.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerSlackBridge, _resetSlackBridgeForTest } = await import("../agent/channels/slack-bridge.js");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const callJson = async (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { type: string; text: string }[])[0].text);
};

{
  const readonlyTools = Object.keys((buildControlServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  ok("read-only server has exactly the declared read tools", JSON.stringify(readonlyTools) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));
  const writeTools = Object.keys((buildControlServer({ includeWrites: true, actor: "t" }) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  ok("write server exposes all the mutating tools", CONTROL_WRITE_TOOL_NAMES.every((t) => writeTools.includes(t)));
  ok("write server still exposes the read tools", CONTROL_TOOL_NAMES.every((t) => writeTools.includes(t)));
  const undeclared = writeTools.filter((t) => !(CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes(t) && !(CONTROL_TOOL_NAMES as readonly string[]).includes(t));
  ok(`write server registers NOTHING undeclared (found: ${undeclared.join(", ") || "none"})`, undeclared.length === 0);
}

const server = buildControlServer({ includeWrites: true, actor: "admin@example.com" });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "write-test", version: "0" });
await client.connect(clientT);

{
  const before = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("no override → config caps (uncapped)", before.surfaceMonthlyTokens === undefined);
  const r = await callJson(client, "set_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 1000 });
  ok("set_spend_limit returns ok", r.ok === true && r.monthlyTokens === 1000);
  const after = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("effectiveCaps now reflects the admin-set surface limit", after.surfaceMonthlyTokens === 1000);
  ok("the override is scoped to its surface", (await effectiveCaps("default", "slack/T1", "slack/T1/C2")).surfaceMonthlyTokens === undefined);
  ok("applyCapOverrides is the pure form of the overlay", applyCapOverrides({}, [{ org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 1000 }], "slack/T1", "slack/T1/C1").surfaceMonthlyTokens === 1000);
}

{
  const r = await callJson(client, "set_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyUsd: 25.5 });
  ok("set_spend_limit accepts a USD-only override", r.ok === true && r.monthlyUsd === 25.5 && r.monthlyTokens === undefined);
  const after = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("effectiveCaps reflects the admin-set USD limit", after.surfaceMonthlyUsd === 25.5);
  ok("the USD-only row replaced the token row (one override per scope+level)", after.surfaceMonthlyTokens === undefined);
  const bad = await client.callTool({ name: "set_spend_limit", arguments: { org: "default", scopeKey: "slack/T1/C1", level: "surface" } });
  ok("set_spend_limit with no component is refused", bad.isError === true);
}

{
  const r = await callJson(client, "clear_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface" });
  ok("clear_spend_limit reports cleared", r.cleared === true);
  const after = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok("effectiveCaps reverts to config after clear", after.surfaceMonthlyTokens === undefined && after.surfaceMonthlyUsd === undefined);
}

{
  const scopeKey = "slack/T1/C-OWNED";
  const reason = "e2e-run-owned";
  const first = await callJson(client, "set_spend_limit", {
    org: "default", scopeKey, level: "surface", monthlyTokens: 1, ttlSeconds: 1800, reason, ifAbsent: true,
  });
  ok("conditional spend set creates an absent row", first.created === true && first.setBy === "admin@example.com" && typeof first.expiresAt === "number");
  const conflict = await callJson(client, "set_spend_limit", {
    org: "default", scopeKey, level: "surface", monthlyTokens: 99, ttlSeconds: 1800, reason: "somebody-else", ifAbsent: true,
  });
  ok("conditional spend set reports the occupied address without replacing it", conflict.created === false);
  ok("the conflicting conditional set preserved the owned row", (await getOperationalStore().spendLimits("default")).find((r) => r.scopeKey === scopeKey)?.monthlyTokens === 1);

  const expected = { monthlyTokens: 1, expiresAt: first.expiresAt, reason, setBy: first.setBy };
  const wrong = await callJson(client, "clear_spend_limit", { org: "default", scopeKey, level: "surface", expected: { ...expected, reason: "wrong" } });
  ok("conditional spend clear refuses a changed ownership handle", wrong.cleared === false);
  ok("the refused conditional clear leaves the row", (await getOperationalStore().spendLimits("default")).some((r) => r.scopeKey === scopeKey));
  const exact = await callJson(client, "clear_spend_limit", { org: "default", scopeKey, level: "surface", expected });
  ok("conditional spend clear removes its exact unchanged row", exact.cleared === true);
}

{
  const scopeKey = "slack/T1/C-HALT-OWNED";
  const address = { orgWide: false as const, level: "surface" as const, scopeKey };
  await getOperationalStore().setHalt("default", address, { setBy: "U-driver" });
  const drift = await callJson(client, "overrides_list", { org: "default" });
  const owned = drift.halts.find((h: { scopeKey?: string }) => h.scopeKey === scopeKey);
  ok("overrides_list exposes the exact active halt ownership facts", owned?.setBy === "U-driver" && typeof owned?.setAt === "string");
  const wrong = await callJson(client, "resume", { org: "default", level: "surface", scopeKey, expected: { setAt: owned.setAt, setBy: "not-the-driver" } });
  ok("conditional resume refuses a changed halt owner", wrong.cleared === false);
  ok("the refused conditional resume leaves the halt active", (await getOperationalStore().activeHalts("default")).some((h) => !h.address.orgWide && h.address.scopeKey === scopeKey));
  const exact = await callJson(client, "resume", { org: "default", level: "surface", scopeKey, expected: { setAt: owned.setAt, setBy: owned.setBy } });
  ok("conditional resume clears its exact unchanged halt", exact.cleared === true);
}

{
  await callJson(client, "revoke_connector", { org: "default", surfaceKey: "slack/T1/C1", connector: "notion" });
  let ov = await getOperationalStore().connectorOverrides("default", "slack/T1/C1");
  ok("revoke_connector persists a denied override", ov.some((o) => o.connector === "notion" && o.granted === false));
  ok("overlay removes a revoked connector even if config granted it", !applyConnectorOverrides(["notion"], ov).includes("notion"));

  ok(
    "overlay never widens: a granted=true override does not add an un-configured connector",
    !applyConnectorOverrides([], [{ connector: "notion", granted: true }]).includes("notion"),
  );
  ok(
    "overlay never widens: granted=true is inert even alongside the base",
    JSON.stringify(applyConnectorOverrides(["linear"], [{ connector: "notion", granted: true }])) === JSON.stringify(["linear"]),
  );

  const r = await callJson(client, "clear_connector_override", { org: "default", surfaceKey: "slack/T1/C1", connector: "notion" });
  ok("clear_connector_override reports cleared", r.cleared === true);
  ov = await getOperationalStore().connectorOverrides("default", "slack/T1/C1");
  ok("clear removes the override row (reverts to config)", !ov.some((o) => o.connector === "notion"));
  const again = await callJson(client, "clear_connector_override", { org: "default", surfaceKey: "slack/T1/C1", connector: "notion" });
  ok("clearing a missing override reports cleared=false", again.cleared === false);
}

{
  await getOperationalStore().addRoutine({ id: "r-1", org: "default", surfaceKey: "slack/T1/C1", trigger: { kind: "interval", everyMinutes: 60 }, prompt: "x", createdAt: "2026-06-25T00:00:00Z", status: "active", consecutiveFailures: 0 });
  const r = await callJson(client, "cancel_routine", { org: "default", surfaceKey: "slack/T1/C1", id: "r-1" });
  ok("cancel_routine cancels an existing routine", r.cancelled === true);
  ok("routine is gone after cancel", (await getOperationalStore().listRoutines("default", "slack/T1/C1")).length === 0);
  const miss = await callJson(client, "cancel_routine", { org: "default", surfaceKey: "slack/T1/C1", id: "nope" });
  ok("cancelling a missing routine reports cancelled=false", miss.cancelled === false);
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists delete_skill", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("delete_skill"));

  await getOperationalStore().putDomainSkill("default", "eng", "runbook", "# Steps", "U1", "2026-07-04T10:00:00Z");

  const otherDomainServer = buildControlServer({ includeWrites: true, actor: "other-op", roles: ["domain:other"] });
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await otherDomainServer.connect(s1);
  const otherClient = new Client({ name: "delete-skill-denied", version: "0" });
  await otherClient.connect(c1);
  const denied = await otherClient.callTool({ name: "delete_skill", arguments: { org: "default", domain: "eng", name: "runbook" } });
  ok("delete_skill: an uncovered domain role is denied", denied.isError === true);
  ok(
    "delete_skill: a denied call doesn't touch the store",
    (await getOperationalStore().listDomainSkills("default", "eng")).some((s: { name: string }) => s.name === "runbook"),
  );
  await otherClient.close();

  const r = await callJson(client, "delete_skill", { org: "default", domain: "eng", name: "runbook" });
  ok("delete_skill: happy path deletes the seeded skill", r.ok === true && r.deleted === true);
  ok(
    "delete_skill: skill is gone from the store",
    !(await getOperationalStore().listDomainSkills("default", "eng")).some((s: { name: string }) => s.name === "runbook"),
  );

  const miss = await callJson(client, "delete_skill", { org: "default", domain: "eng", name: "runbook" });
  ok("delete_skill: deleting an already-gone skill reports deleted:false (not an error)", miss.ok === true && miss.deleted === false);
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists directory_groups_plan", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("directory_groups_plan"));
  const planOnly = await callJson(client, "directory_groups_plan", { org: "default" });
  ok("directory_groups_plan is cleanly-off with no directory adapter (plan mode)", planOnly.ok === true && planOnly.provider === null);
  const deliver = await callJson(client, "directory_groups_plan", { org: "default", deliver: true });
  ok("directory_groups_plan deliver:true is cleanly-off with no directory adapter (never reaches the repo gate)", deliver.ok === true && deliver.provider === null);
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists reopen_slack_setup", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("reopen_slack_setup"));

  const noArm = await client.callTool({ name: "reopen_slack_setup", arguments: { org: "default" } });
  const noArmText = (noArm.content as { type: string; text: string }[])[0].text;
  ok("reopen_slack_setup with no Slack provider wired reports an error", noArm.isError === true);
  ok("…and the error says no Slack provider is wired", noArmText.includes("no Slack provider is wired"));
  ok("…rather than reporting a reopen that did not happen", !noArmText.includes('"reopened": true'));

  const foreign = await client.callTool({ name: "reopen_slack_setup", arguments: { org: "some-other-tenant" } });
  ok("reopen_slack_setup refuses a foreign org", foreign.isError === true);
  ok("…naming it as not this deployment's org", (foreign.content as { type: string; text: string }[])[0].text.includes("not this deployment's org"));

  const domainServer = buildControlServer({ includeWrites: true, actor: "eng-admin@example.com", roles: ["domain:eng"] });
  const [dClientT, dServerT] = InMemoryTransport.createLinkedPair();
  await domainServer.connect(dServerT);
  const domainClient = new Client({ name: "domain-role-test", version: "0" });
  await domainClient.connect(dClientT);
  const denied = await domainClient.callTool({ name: "reopen_slack_setup", arguments: { org: "default" } });
  const deniedText = (denied.content as { type: string; text: string }[])[0].text;
  ok("reopen_slack_setup refuses a domain role", denied.isError === true);
  ok("…citing the org-wide admin requirement", deniedText.includes("requires the org-wide") && deniedText.includes("admin"));
  await domainClient.close();

  const beforeRows = await readAudit({ org: "default", limit: 200 });
  ok("a refused reopen_slack_setup appends no audit row", !beforeRows.some((r) => r.action === "slack.setup_reopened"));

  // proves: slack.setup_reopened
  let reopenCalls = 0;
  registerSlackBridge({
    ...({} as unknown as Parameters<typeof registerSlackBridge>[0]),
    reopenSetup: async () => {
      reopenCalls++;
      return true;
    },
  });
  try {
    const done = await callJson(client, "reopen_slack_setup", { org: "default" });
    ok("reopen_slack_setup calls the registered Slack arm", reopenCalls === 1);
    ok("reopen_slack_setup reports the arm's verdict", done.ok === true && done.reopened === true);

    const rows = await readAudit({ org: "default", limit: 200 });
    const row = rows.find((r) => r.action === "slack.setup_reopened");
    ok("a successful reopen_slack_setup appends slack.setup_reopened", row !== undefined);
    ok("…carrying the acting principal", row?.principalId === "admin@example.com");
    ok("…and the verdict in its detail", JSON.stringify(row?.detail ?? {}).includes("true"));

    registerSlackBridge({
      ...({} as unknown as Parameters<typeof registerSlackBridge>[0]),
      reopenSetup: async () => false,
    });
    const already = await callJson(client, "reopen_slack_setup", { org: "default" });
    ok("reopen_slack_setup on an already-open page reports reopened:false, not an error", already.ok === true && already.reopened === false);
  } finally {
    _resetSlackBridgeForTest();
  }
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists adopt_env_secrets", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("adopt_env_secrets"));
  const { randomBytes } = await import("node:crypto");
  const { getOperatorSecret, setOperatorSecret, resetOperatorSecretWarnings } = await import("../agent/credentials/operator-secrets.js");
  const { registerOperatorSecretNames } = await import("../agent/ops/operator-secret-roster.js");
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const SENTINEL = "adopt-SENTINEL-VALUE-7f3e9a1c-DO-NOT-LEAK";
  const SENTINEL_2 = "adopt-SENTINEL-ROTATED-2b8d4e6f-DO-NOT-LEAK";
  const textOf = (res: Awaited<ReturnType<typeof client.callTool>>) => (res.content as { type: string; text: string }[])[0].text;
  const adoptRows = async () => (await readAudit({ org: "default", limit: 500 })).filter((r) => r.action === "admin.secret.adopt_env");
  const ADOPT = "OE_LOG_SHIP_TOKEN";
  const UNSET = "OE_TELEMETRY_OTLP_HEADERS";
  const KEPT = "OE_EGRESS_PROXY_TOKEN";
  process.env[ADOPT] = SENTINEL;
  delete process.env[UNSET];
  process.env[KEPT] = SENTINEL_2;
  await setOperatorSecret({ name: KEPT, value: "the-stored-rotation", setBy: "operator:cli" });

  const domainServer = buildControlServer({ includeWrites: true, actor: "eng-admin@example.com", roles: ["domain:eng"] });
  const [dClientT, dServerT] = InMemoryTransport.createLinkedPair();
  await domainServer.connect(dServerT);
  const domainClient = new Client({ name: "domain-role-adopt-test", version: "0" });
  await domainClient.connect(dClientT);
  const denied = await domainClient.callTool({ name: "adopt_env_secrets", arguments: { org: "default", names: [ADOPT] } });
  ok("adopt_env_secrets refuses a domain role", denied.isError === true && textOf(denied).includes("requires the org-wide"));
  await domainClient.close();
  const foreign = await client.callTool({ name: "adopt_env_secrets", arguments: { org: "some-other-tenant", names: [ADOPT] } });
  ok("adopt_env_secrets refuses a foreign org", foreign.isError === true && textOf(foreign).includes("not this deployment's org"));
  ok("…and a refused call stores nothing", (await getOperationalStore().getStoredCredential("default", ADOPT)) === null);

  process.env.OE_ADOPT_TEST_NOT_A_SECRET = SENTINEL;
  const unknown = await client.callTool({ name: "adopt_env_secrets", arguments: { org: "default", names: [ADOPT, "OE_ADOPT_TEST_NOT_A_SECRET"] } });
  ok("adopt_env_secrets refuses a name that is not on the operator-secret roster", unknown.isError === true && textOf(unknown).includes("names[1] is not an operator secret"));
  ok("…without echoing the refused name", !textOf(unknown).includes("OE_ADOPT_TEST_NOT_A_SECRET"));
  ok("…and the WHOLE call is refused: the valid name before it is not stored either", (await getOperationalStore().getStoredCredential("default", ADOPT)) === null);
  registerOperatorSecretNames(["DATABASE_URL"]);
  const root = await client.callTool({ name: "adopt_env_secrets", arguments: { org: "default", names: ["DATABASE_URL"] } });
  ok("adopt_env_secrets refuses a root-of-trust name even when it is on the roster", root.isError === true && textOf(root).includes("root-of-trust"));
  const pasted = await client.callTool({ name: "adopt_env_secrets", arguments: { org: "default", names: [SENTINEL] } });
  ok("a value pasted into the names field is refused and not echoed", pasted.isError === true && !textOf(pasted).includes(SENTINEL));
  ok("no refused call wrote an adopt row", (await adoptRows()).length === 0);

  // proves: admin.secret.adopt_env
  const res = await client.callTool({ name: "adopt_env_secrets", arguments: { org: "default", names: [ADOPT, UNSET, KEPT] } });
  const body = JSON.parse(textOf(res)) as { ok: boolean; results: { name: string; outcome: string }[] };
  const outcome = (name: string) => body.results.find((r) => r.name === name)?.outcome;
  ok("adopt_env_secrets reports `stored` for a name the env holds", body.ok === true && outcome(ADOPT) === "stored");
  ok("…`no-env-value` for a name the env does not hold", outcome(UNSET) === "no-env-value");
  ok("…`already-stored` for a name the store holds, without overwrite", outcome(KEPT) === "already-stored");
  ok("🔴 the reply carries no value", !textOf(res).includes(SENTINEL) && !textOf(res).includes(SENTINEL_2));
  delete process.env[ADOPT];
  resetOperatorSecretWarnings();
  const resolved = await getOperatorSecret(ADOPT);
  ok("the adopted value now resolves from the db store", resolved.source === "db" && resolved.value === SENTINEL);
  ok("…stamped with the env-adopt provenance and the acting principal", (await getOperationalStore().getStoredCredential("default", ADOPT))?.createdBy === "operator:env-adopt:admin@example.com");
  ok("the stored row is kept: an env value does not replace it without overwrite", (await getOperatorSecret(KEPT)).value === "the-stored-rotation");
  let rows = await adoptRows();
  ok("a successful call appends one admin.secret.adopt_env row", rows.length === 1 && rows[0].principalId === "admin@example.com");
  ok("…naming each secret and its outcome", JSON.stringify(rows[0].detail).includes(`"${UNSET}":"no-env-value"`));
  ok("🔴 …and no value", !JSON.stringify(rows).includes(SENTINEL) && !JSON.stringify(rows).includes(SENTINEL_2));

  const over = JSON.parse(textOf(await client.callTool({ name: "adopt_env_secrets", arguments: { org: "default", names: [KEPT], overwrite: true } }))) as typeof body;
  ok("overwrite:true replaces a stored row and reports replaced", over.results[0].outcome === "stored" && (over.results[0] as { replaced?: boolean }).replaced === true);
  ok("…with the env value", (await getOperatorSecret(KEPT)).value === SENTINEL_2);

  const st = getOperationalStore() as unknown as { putStoredCredential: (...a: unknown[]) => Promise<void> };
  const realPut = st.putStoredCredential;
  st.putStoredCredential = async () => {
    throw new Error(`constraint failed near '${SENTINEL_2}'`);
  };
  try {
    const fault = await client.callTool({ name: "adopt_env_secrets", arguments: { org: "default", names: [UNSET, KEPT], overwrite: true } });
    ok("a store fault is reported as an error", fault.isError === true && textOf(fault).includes(`adopting ${KEPT} failed`));
    ok("🔴 …with the value scrubbed out of the message", !textOf(fault).includes(SENTINEL_2) && textOf(fault).includes("[redacted]"));
    rows = await adoptRows();
    ok("…and the fault still appends a row, with what was handled before it", rows.length === 3 && JSON.stringify(rows[0].detail).includes(`"${UNSET}":"no-env-value"`));
    ok("🔴 …which carries no value either", !JSON.stringify(rows).includes(SENTINEL_2));
  } finally {
    st.putStoredCredential = realPut;
    delete process.env[KEPT];
    delete process.env.OE_ADOPT_TEST_NOT_A_SECRET;
  }
}

{
  const r = await callJson(client, "set_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 5000, ttlSeconds: 3600, reason: "blocked mid-task" });
  ok("set_spend_limit with ttlSeconds returns a future expiresAt", typeof r.expiresAt === "number" && r.expiresAt > Date.now());
  ok("a future-dated bridge is still applied", (await effectiveCaps("default", "slack/T1", "slack/T1/C1")).surfaceMonthlyTokens === 5000);
  const row = (await getOperationalStore().spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1" && l.level === "surface");
  ok("the spend override stores reason + setBy (the actor)", row?.reason === "blocked mid-task" && row?.setBy === "admin@example.com");

  await callJson(client, "revoke_connector", { org: "default", surfaceKey: "slack/T1/C1", connector: "linear", reason: "leaked token" });

  const drift = await callJson(client, "overrides_list", { org: "default" });
  const sd = drift.spend.find((s: { scopeKey: string; level: string }) => s.scopeKey === "slack/T1/C1" && s.level === "surface");
  ok("drift view lists the spend override with reason/setBy", sd?.reason === "blocked mid-task" && sd?.setBy === "admin@example.com");
  ok("drift view flags the raised cap as diverging, not expired", sd?.divergesFromConfig === true && sd?.expired === false);
  const cd = drift.connectors.find((c: { connector: string }) => c.connector === "linear");
  ok("drift view lists the revoke as sticky with reason", cd?.sticky === true && cd?.granted === false && cd?.reason === "leaked token");

  await callJson(client, "clear_spend_limit", { org: "default", scopeKey: "slack/T1/C1", level: "surface" });
  await callJson(client, "clear_connector_override", { org: "default", surfaceKey: "slack/T1/C1", connector: "linear" });
}

{
  const r = await callJson(client, "cancel_routine", { org: "default", surfaceKey: "payments", id: "no-such-routine" });
  ok("a bare domain-name scope is accepted by the write plane (no format constraint on the param)", r.ok === true && r.cancelled === false);
  const rows = (await readAudit({ org: "default" })).filter((e) => e.action === "admin.routine.cancel" && (e.detail as { id?: string })?.id === "no-such-routine");
  ok("the domain-scoped mutation produced exactly one audit row", rows.length === 1);
  ok(
    "a bare domain NAME audits as platform:'domain' with the domain as the workspace",
    rows[0]?.platform === "domain" && rows[0]?.workspace === "payments",
  );
  ok(
    "…and NOT as the deleted private copy had it — a platform that does not exist, with an unknown workspace",
    !(rows[0]?.platform === "payments" && rows[0]?.workspace === "unknown"),
  );
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists revoke_session_grants", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("revoke_session_grants"));

  {
    const desc = (await client.listTools()).tools.find((t) => t.name === "revoke_session_grants")?.description ?? "";
    ok("🔴 OPE-2363: the description says a conversation keeps no standing grant", desc.includes("keeps no grant") && !desc.includes("Approve for this thread") && !desc.includes("Approve for this DM"));
    ok("🔴 OPE-2363: …names the routine's standing grant as what sessionId withdraws", desc.includes("Approve for this routine (up to N h)"));
    ok("🔴 OPE-2363: …and names the room delete as the UNSPENT one-call approvals", desc.includes("has not spent yet"));
    ok("🔴 OPE-2363: …and says a Discord thread or Teams reply chain is reached through its parent channel", desc.includes("parent channel"));
    ok("…while stating the effect on a ROUTINE grant key", desc.includes("connector.tool:"));
    ok("…while still pointing at revoke_connector as the ACCESS remedy", desc.includes("revoke_connector"));
  }

  const { conversationGrantKey } = await import("../agent/approvals/session-grant.js");
  const store = getOperationalStore();
  const now = new Date();
  const future = new Date(now.getTime() + 3_600_000).toISOString();
  const room = { platform: "slack", workspace: "T1", surface: "C1", mode: "channel" } as const;
  const threadA = conversationGrantKey({ ...room, threadTs: "1718884080.000100" })!;
  const threadB = conversationGrantKey({ ...room, threadTs: "1718884080.000200" })!;
  const otherRoom = conversationGrantKey({ ...room, surface: "C2", threadTs: "1718884080.000100" })!;
  const dm = conversationGrantKey({ platform: "slack", workspace: "T1", surface: "C1", mode: "dm" })!;
  ok("precondition: thread A, thread B and the DM are three different keys of one room", new Set([threadA, threadB, dm]).size === 3 && threadA.startsWith("oe-grant:slack/T1/C1:"));
  for (const [sid, kind] of [
    [threadA, "pr.open"],
    [threadA, "connector.approved:notion__create_page"],
    [threadB, "pr.open"],
    [dm, "pr.open"],
    [otherRoom, "pr.open"],
  ] as const) {
    await store.setSessionApproval({ org: "default", sessionId: sid, kind, grantedBy: "U_ADMIN", createdAt: now.toISOString(), expiresAt: future });
  }

  const r = await callJson(client, "revoke_session_grants", { org: "default", surfaceKey: "slack/T1/C1", reason: "granted too widely" });
  ok("🔴 revoke_session_grants by surface key deletes every grant in the room: two threads, the DM, and the approved connector op", r.ok === true && r.revoked === 4 && r.prefix === "oe-grant:slack/T1/C1:");
  ok("…so the next pr.open in thread A gets a card again", (await store.getSessionApproval("default", threadA, "pr.open", new Date().toISOString())) === null);
  ok("…and in thread B", (await store.getSessionApproval("default", threadB, "pr.open", new Date().toISOString())) === null);
  ok("…and the approved connector op in thread A is gone too", (await store.getSessionApproval("default", threadA, "connector.approved:notion__create_page", new Date().toISOString())) === null);
  ok(
    "🔴 SCOPED: another room keeps its grants (revoking one room is not a blast radius)",
    (await store.getSessionApproval("default", otherRoom, "pr.open", new Date().toISOString()))?.grantedBy === "U_ADMIN",
  );

  const empty = await callJson(client, "revoke_session_grants", { org: "default", surfaceKey: "slack/T1/C_NONE" });
  ok("a room that holds no grant answers ok with revoked 0", empty.ok === true && empty.revoked === 0);

  await store.setSessionApproval({ org: "default", sessionId: threadA, kind: "pr.open", grantedBy: "U_ADMIN", createdAt: now.toISOString(), expiresAt: future });
  await store.setSessionApproval({ org: "default", sessionId: threadB, kind: "pr.open", grantedBy: "U_ADMIN", createdAt: now.toISOString(), expiresAt: future });
  const direct = await callJson(client, "revoke_session_grants", { org: "default", surfaceKey: "slack/T1/C1", sessionId: threadA });
  ok("an explicit sessionId revokes exactly that thread", direct.ok === true && direct.revoked === 1);
  ok("…and the other thread of the room keeps its grant", (await store.getSessionApproval("default", threadB, "pr.open", new Date().toISOString())) !== null);
  const foreign = await client.callTool({ name: "revoke_session_grants", arguments: { org: "default", surfaceKey: "slack/T1/C1", sessionId: otherRoom } });
  ok("🔴 an explicit sessionId of another room is REFUSED", foreign.isError === true && (foreign.content as { text: string }[])[0].text.includes("is not a grant key of"));
  ok("…and that room's grant is untouched", (await store.getSessionApproval("default", otherRoom, "pr.open", new Date().toISOString())) !== null);
  await store.setSessionApproval({ org: "default", sessionId: "oe-grant:slack/T1/CX:dm", kind: "pr.open", grantedBy: "U_ADMIN", createdAt: now.toISOString(), expiresAt: future });
  ok("🔴 a LIKE metacharacter in the prefix widens nothing", (await store.revokeSessionApprovalsByPrefix("default", "oe-grant:slack/T1/C_:")) === 0);
  ok("…and the row it would have matched as a pattern is still there", (await store.getSessionApproval("default", "oe-grant:slack/T1/CX:dm", "pr.open", new Date().toISOString())) !== null);

  {
    const { routinePermissionKey } = await import("../agent/routines/routine.js");
    await store.addRoutine({ id: "r-room-a", org: "default", surfaceKey: "slack/T1/C_ROOM_A", trigger: { kind: "interval", everyMinutes: 60 }, prompt: "x", createdAt: "2026-06-25T00:00:00Z", status: "active", consecutiveFailures: 0 });
    await store.addRoutine({ id: "r-room-b", org: "default", surfaceKey: "slack/T1/C_ROOM_B", trigger: { kind: "interval", everyMinutes: 60 }, prompt: "x", createdAt: "2026-06-25T00:00:00Z", status: "active", consecutiveFailures: 0 });
    const keyA = routinePermissionKey({ id: "r-room-a" });
    const keyB = routinePermissionKey({ id: "r-room-b" });
    for (const sid of [keyA, keyB]) {
      await store.setSessionApproval({ org: "default", sessionId: sid, kind: "pr.open", grantedBy: "U_ADMIN", createdAt: now.toISOString(), expiresAt: future });
    }
    const roomAClient = client;
    const crossRoom = await roomAClient.callTool({ name: "revoke_session_grants", arguments: { org: "default", surfaceKey: "slack/T1/C_ROOM_A", sessionId: keyB } });
    ok("🔴 a call on room A's surfaceKey cannot revoke room B's routine grant", crossRoom.isError === true && (crossRoom.content as { text: string }[])[0].text.includes("is not the grant key of a routine of"));
    ok("…and room B's routine grant is untouched", (await store.getSessionApproval("default", keyB, "pr.open", new Date().toISOString())) !== null);
    const gone = await roomAClient.callTool({ name: "revoke_session_grants", arguments: { org: "default", surfaceKey: "slack/T1/C_ROOM_A", sessionId: "oe-routine:r-deleted:g1" } });
    ok("…and a routine key whose routine no longer exists is refused the same way", gone.isError === true);
    const own = await roomAClient.callTool({ name: "revoke_session_grants", arguments: { org: "default", surfaceKey: "slack/T1/C_ROOM_A", sessionId: keyA } });
    const ownJson = JSON.parse((own.content as { text: string }[])[0].text) as { ok?: boolean; revoked?: number };
    ok("negative control: the same call shape revokes room A's OWN routine grant", own.isError !== true && ownJson.ok === true && ownJson.revoked === 1);
    ok("…and room A's routine grant is gone", (await store.getSessionApproval("default", keyA, "pr.open", new Date().toISOString())) === null);
  }

  const rows = await readAudit({ org: "default", action: "admin.session_grants.revoke" });
  const row = rows.find((e) => (e.detail as { prefix?: string })?.prefix === "oe-grant:slack/T1/C1:" && (e.detail as { reason?: string })?.reason === "granted too widely");
  ok("revoke_session_grants is audited with the actor, the prefix and the count", row?.principalId === "admin@example.com" && (row?.detail as { revoked?: number })?.revoked === 4);
  ok("every allowed revoke wrote its own row (the explicit-sessionId path is audited too); a refused one wrote none", rows.length === 4);
}

{
  const audit = await readAudit({ org: "default" });
  const actions = audit.map((e) => e.action);
  for (const a of ["admin.spend.set_limit", "admin.spend.clear_limit", "admin.connector.revoke", "admin.connector.clear_override", "admin.routine.cancel", "skill.delete", "admin.session_grants.revoke"]) {
    ok(`audited: ${a}`, actions.includes(a));
  }
  ok("write actions carry the acting principal", audit.filter((e) => e.action.startsWith("admin.")).every((e) => e.principalId === "admin@example.com"));
  ok(
    "delete_skill audits with the control actor, same action string the agent-side delete_skill tool uses (skill.delete)",
    audit.some((e) => e.action === "skill.delete" && e.principalId === "admin@example.com" && (e.detail as { name?: string })?.name === "runbook"),
  );
}

await client.close();
await removeTempDir(dir);
console.log(`\n✓ control write tools: ${n} assertions passed (mutations overlay config-as-code + are audited)\n`);

// proves: CTRL-cancel_routine, CTRL-clear_connector_override, CTRL-clear_spend_limit, CTRL-delete_skill
// proves: CTRL-directory_groups_plan, CTRL-overrides_list, CTRL-reopen_slack_setup, CTRL-revoke_connector
// proves: CTRL-revoke_session_grants, CTRL-set_spend_limit, CTRL-adopt_env_secrets
