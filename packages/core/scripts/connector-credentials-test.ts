// proves: AP-MOD-core-access-connector-credentials

import {
  assertConnectorCredentialsValid,
  defineConnectorCredentials,
  expandConnectorGrant,
  principalOf,
  oauthConnectorHome,
  oauthConnectorOf,
  type ConnectorCredentials,
} from "../agent/access/connector-credentials.js";
import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import type { Binding, Bundle } from "../agent/access/bundle.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => unknown, fragment: string, label: string): void {
  let threw = false;
  let error: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    error = err;
  }
  if (!threw) {
    console.error(`✗ ${label} (expected a throw, got none)`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(fragment)) {
    console.error(`✗ ${label} (threw, but not the refusal under test — expected "${fragment}", got: ${message})`);
    process.exit(1);
  }
  passed++;
}

const notion: ConnectorCredentials = defineConnectorCredentials({
  connector: "notion",
  allows: ["api-key", "service-oauth", "user-oauth"],
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "NOTION_TEAM", broker: "env" },
    { id: "team-oauth", type: "service-oauth", home: oauthConnectorHome("oauth/notion-app") },
    { id: "mine", type: "user-oauth", home: oauthConnectorHome("oauth/notion-user") },
  ],
});

ok(principalOf("api-key") === "app", "api-key is app principal");
ok(principalOf("service-oauth") === "app", "service-oauth is app principal");
ok(principalOf("user-oauth") === "user", "user-oauth is user principal (DM universe)");

assertConnectorCredentialsValid([notion]);
passed++;
throwsWith(() => assertConnectorCredentialsValid([notion, notion]), 'connector "notion": a second credential catalogue names the same connector', "duplicate provider name throws");
throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "x", allows: ["api-key"], credentials: [{ id: "k", type: "api-key" }] }]),
  'connector "x" credential "k": api-key needs a secretRef',
  "api-key credential without secretRef throws",
);
throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "x", allows: ["api-key"], credentials: [{ id: "k", type: "api-key", secretRef: "K" }] }]),
  'connector "x" credential "k": api-key needs an explicit broker stamp',
  "api-key credential without an explicit broker stamp throws (a credential has exactly one home)",
);
throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "x", allows: ["service-oauth"], credentials: [{ id: "o", type: "service-oauth" }] }]),
  'connector "x" credential "o": service-oauth needs a home',
  "service-oauth credential without oauthConnector throws",
);
throwsWith(
  () =>
    assertConnectorCredentialsValid([
      { connector: "x", allows: ["user-oauth"], credentials: [{ id: "o", type: "user-oauth", home: { kind: "vercel-connect", config: { connector: "oauth/x" } } }] },
    ]),
  'connector "x" credential "o": credential home kind "vercel-connect" is retired — rename it to "oauth"',
  "a credential homed at the retired kind throws and names the new kind",
);
ok(oauthConnectorHome("oauth/x").kind === "oauth", "oauthConnectorHome builds the `oauth` kind");
assertConnectorCredentialsValid([{ connector: "x", allows: ["user-oauth"], credentials: [{ id: "o", type: "user-oauth", home: { kind: "oauth", config: { connector: "oauth/x" } } }] }]);
ok(true, "a credential homed at the `oauth` kind loads");
throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "", allows: ["api-key"], credentials: [] }]),
  "connector credentials: missing connector slug",
  "a catalogue with no connector slug throws",
);
throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "x", allows: [], credentials: [] }]),
  'connector "x": empty credential allowlist',
  "a catalogue with an empty allowlist throws",
);

{
  const r = expandConnectorGrant({ name: "notion", credential: "nope" }, notion, { dm: false });
  ok(r.resolved === null && r.warnings.some((w) => w.includes("unknown credential")), "unknown credential → warn, nothing");
}
{
  const r = expandConnectorGrant({ name: "notion", credential: "x" }, undefined, { dm: false });
  ok(r.resolved === null && r.warnings.some((w) => w.includes("no credential catalogue")), "a connector with NO catalogue → warn, nothing");
}
{
  const r = expandConnectorGrant({ name: "notion", credential: "team-key" }, notion, { dm: false });
  ok(r.resolved?.connector === "notion" && r.resolved?.secretRef === "NOTION_TEAM", "api-key resolves to the connection with its secretRef");
  ok(r.resolved?.principal === "app" && r.resolved?.type === "api-key", "binding is app principal, api-key type");
}
{
  const r = expandConnectorGrant({ name: "notion", credential: "team-oauth" }, notion, { dm: false });
  ok(r.resolved !== null && oauthConnectorOf(r.resolved) === "oauth/notion-app" && r.resolved?.principal === "app", "service-oauth carries its oauth connector");
}
{
  const restrictive: ConnectorCredentials = { ...notion, allows: ["service-oauth"] };
  const r = expandConnectorGrant({ name: "notion", credential: "team-key" }, restrictive, { dm: false });
  ok(r.resolved === null && r.warnings.some((w) => w.includes("not in the connection's allowlist")), "credential type outside the allowlist is rejected");
}
{
  const r = expandConnectorGrant({ name: "notion", credential: "mine" }, notion, { dm: false });
  ok(r.resolved === null && r.warnings.some((w) => w.includes("personal credentials resolve only in DMs")), "user-oauth on a channel is blocked (universe gate)");
}
{
  const r = expandConnectorGrant({ name: "notion", credential: "mine" }, notion, { dm: true });
  ok(r.resolved?.principal === "user", "user-oauth resolves in a DM, as a user principal");
}

{
  const tightProvider: ConnectorCredentials = {
    ...notion,
    credentials: [...notion.credentials, { id: "payments-key", type: "api-key", secretRef: "NOTION_PAYMENTS", broker: "env" }],
  };
  const bundles: Bundle[] = [
    { name: "org-notion", connectors: [{ name: "notion", credential: "team-key", contentOrigin: "external" }] },
    { name: "payments-notion", connectors: [{ name: "notion", credential: "payments-key", contentOrigin: "external" }] },
  ];
  const bindings: Binding[] = [
    { bundle: "org-notion", scope: { level: "org" } },
    { bundle: "payments-notion", scope: { level: "domain", domain: "payments" } },
  ];
  const req: ResolveRequest = { mode: "channel", platform: "slack", workspace: "T1", channel: "C", domains: ["payments"] };
  const eff = resolveAccess(req, bundles, bindings, {}, [tightProvider]);
  ok(eff.connectors.includes("notion"), "provider grant folds the connection slug into connectors");
  ok(eff.connectorCredentials["notion"]?.secretRef === "NOTION_PAYMENTS", "narrowest-wins: the domain's tight key overrides the org key");

  const other = resolveAccess({ ...req, domains: [] }, bundles, bindings, {}, [tightProvider]);
  ok(other.connectorCredentials["notion"]?.secretRef === "NOTION_TEAM", "a different surface keeps the org-wide key");
}

{
  const bundles: Bundle[] = [{ name: "b", connectors: [{ name: "notion", credential: "team-key", contentOrigin: "external" }] }];
  const bindings: Binding[] = [{ bundle: "b", scope: { level: "tenant", tenant: "slack/T1" } }];
  const req: ResolveRequest = { mode: "channel", platform: "slack", workspace: "T1", channel: "C" };
  const eff = resolveAccess(req, bundles, bindings, {}, [notion]);
  ok(eff.warnings.some((w) => w.includes("broad grant") && w.includes("connector(s)")), "a connector grant at tenant scope warns (broad blast radius)");
}

console.log(`✓ connector-credentials: ${passed} assertions passed (validation, allowlist, universe gate, narrowest-wins credential)`);
