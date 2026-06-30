import {
  assertProvidersValid,
  defineProvider,
  expandProviderGrant,
  principalOf,
  type Provider,
} from "../agent/access/providers.js";
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
function throws(fn: () => void, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}

const notion: Provider = defineProvider({
  name: "notion",
  transports: [
    { kind: "mcp", connection: "notion", allows: ["service-oauth", "user-oauth"] },
    { kind: "rest", connection: "notion-rest", allows: ["api-key", "service-oauth"] },
  ],
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "NOTION_TEAM" },
    { id: "team-oauth", type: "service-oauth", vercelConnector: "oauth/notion-app" },
    { id: "mine", type: "user-oauth", vercelConnector: "oauth/notion-user" },
  ],
  defaultTransport: "rest",
});

ok(principalOf("api-key") === "app", "api-key is app principal");
ok(principalOf("service-oauth") === "app", "service-oauth is app principal");
ok(principalOf("user-oauth") === "user", "user-oauth is user principal (DM universe)");

assertProvidersValid([notion]);
passed++;
throws(() => assertProvidersValid([notion, notion]), "duplicate provider name throws");
throws(
  () => assertProvidersValid([{ name: "x", transports: [{ kind: "rest", connection: "c", allows: ["api-key"] }], credentials: [{ id: "k", type: "api-key" }] }]),
  "api-key credential without secretRef throws",
);
throws(
  () => assertProvidersValid([{ name: "x", transports: [{ kind: "mcp", connection: "c", allows: ["service-oauth"] }], credentials: [{ id: "o", type: "service-oauth" }] }]),
  "service-oauth credential without vercelConnector throws",
);
throws(
  () => assertProvidersValid([{ name: "x", transports: [{ kind: "rest", connection: "c", allows: ["api-key"] }], credentials: [], defaultTransport: "mcp" }]),
  "defaultTransport with no matching transport throws",
);
throws(
  () => assertProvidersValid([{ name: "x", transports: [], credentials: [] }]),
  "provider with no transports throws",
);

{
  const r = expandProviderGrant({ provider: "notion", credential: "nope" }, notion, { dm: false });
  ok(r.resolved.length === 0 && r.warnings.some((w) => w.includes("unknown credential")), "unknown credential → warn, nothing");
}
{
  const r = expandProviderGrant({ provider: "notion", credential: "x" }, undefined, { dm: false });
  ok(r.resolved.length === 0 && r.warnings.some((w) => w.includes("unknown provider")), "unknown provider → warn, nothing");
}
{
  const r = expandProviderGrant({ provider: "notion", credential: "team-key", transports: ["mcp"] }, notion, { dm: false });
  ok(r.resolved.length === 0 && r.warnings.some((w) => w.includes("not allowed on the \"mcp\"")), "api-key on mcp is rejected (allowlist)");
}
{
  const r = expandProviderGrant({ provider: "notion", credential: "team-key" }, notion, { dm: false });
  ok(r.resolved.length === 1 && r.resolved[0].connection === "notion-rest", "api-key defaults to the rest transport");
  ok(r.resolved[0].secretRef === "NOTION_TEAM" && r.resolved[0].type === "api-key", "rest binding carries the api-key secretRef");
}
{
  const r = expandProviderGrant({ provider: "notion", credential: "team-oauth", transports: ["mcp", "rest"] }, notion, { dm: false });
  ok(r.resolved.length === 2, "service-oauth is valid on both transports");
  ok(r.resolved.every((rc) => rc.principal === "app" && rc.vercelConnector === "oauth/notion-app"), "oauth bindings carry the connect connector, app principal");
}
{
  const r = expandProviderGrant({ provider: "notion", credential: "mine" }, notion, { dm: false });
  ok(r.resolved.length === 0 && r.warnings.some((w) => w.includes("personal credentials resolve only in DMs")), "user-oauth on a channel is blocked (universe gate)");
}
{
  const noDefault: Provider = { ...notion, defaultTransport: undefined };
  const r = expandProviderGrant({ provider: "notion", credential: "team-oauth" }, noDefault, { dm: false });
  ok(r.resolved.length === 2 && r.warnings.some((w) => w.includes("pins no transport")), "multi-transport with no default exposes all + warns");
}

{
  const provs = [notion];
  const tightProvider: Provider = {
    ...notion,
    credentials: [...notion.credentials, { id: "payments-key", type: "api-key", secretRef: "NOTION_PAYMENTS" }],
  };
  const bundles: Bundle[] = [
    { name: "org-notion", providers: [{ provider: "notion", credential: "team-key" }] },
    { name: "payments-notion", providers: [{ provider: "notion", credential: "payments-key" }] },
  ];
  const bindings: Binding[] = [
    { bundle: "org-notion", scope: { level: "org" } },
    { bundle: "payments-notion", scope: { level: "domain", workspace: "slack/T", domain: "payments" } },
  ];
  const req: ResolveRequest = { mode: "channel", platform: "slack", workspace: "slack/T", channel: "C", domains: ["payments"] };
  const eff = resolveAccess(req, bundles, bindings, {}, [tightProvider]);
  ok(eff.connectors.includes("notion-rest"), "provider grant folds the transport slug into connectors");
  ok(eff.connectorCredentials["notion-rest"]?.secretRef === "NOTION_PAYMENTS", "narrowest-wins: the domain's tight key overrides the org key");

  const other = resolveAccess({ ...req, domains: [] }, bundles, bindings, {}, [tightProvider]);
  ok(other.connectorCredentials["notion-rest"]?.secretRef === "NOTION_TEAM", "a different surface keeps the org-wide key");
}

{
  const bundles: Bundle[] = [{ name: "b", providers: [{ provider: "notion", credential: "team-key" }] }];
  const bindings: Binding[] = [{ bundle: "b", scope: { level: "workspace", workspace: "slack/T" } }];
  const req: ResolveRequest = { mode: "channel", platform: "slack", workspace: "slack/T", channel: "C" };
  const eff = resolveAccess(req, bundles, bindings, {}, [notion]);
  ok(eff.warnings.some((w) => w.includes("broad grant") && w.includes("provider credential")), "provider grant at workspace scope warns (broad blast radius)");
}

console.log(`✓ providers: ${passed} assertions passed (validation, allowlist, universe gate, narrowest-wins credential)`);
