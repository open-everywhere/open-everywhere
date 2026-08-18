import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-transport-host-fence-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_ORG;
process.env.OE_PLATFORM = "slack";

import type { CredentialEndpointRules } from "../agent/access/credential-endpoints.js";
import type { CredentialBroker } from "../agent/access/credentials.js";

const { credentialEndpointHostVerdict, assertCredentialEndpointHostAllowed, CredentialEndpointError } = await import(
  "../agent/access/credential-endpoints.js"
);
const { registerBroker, resetBrokers } = await import("../agent/access/credentials.js");
const { resolveAppTokenFromCred, userAwareProviderToken } = await import("../agent/connections/connector-auth.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const HOSTS_ONLY: CredentialEndpointRules = { hosts: ["mcp.vendor.com"] };
const REST_SHAPED: CredentialEndpointRules = {
  hosts: ["mcp.vendor.com"],
  pathPrefixes: ["/v1/comments"],
  methods: ["GET"],
};

ok(
  credentialEndpointHostVerdict(undefined, "https://anything.example.com/mcp").allowed,
  "§1 no rules ⇒ unnarrowed, exactly like the REST verdict",
);
ok(credentialEndpointHostVerdict(HOSTS_ONLY, "https://mcp.vendor.com/mcp").allowed, "§1 positive control: the declared host is allowed");
ok(!credentialEndpointHostVerdict(HOSTS_ONLY, "https://evil.example.com/mcp").allowed, "🔴 §1 ACCEPTANCE: a wrong host is refused");
ok(
  (credentialEndpointHostVerdict(HOSTS_ONLY, "https://evil.example.com/mcp").reason ?? "").includes("evil.example.com"),
  "§1 the refusal names the host",
);
ok(!credentialEndpointHostVerdict(HOSTS_ONLY, "https://sub.mcp.vendor.com/mcp").allowed, "§1 a subdomain of the declared host is refused — no widening");
ok(
  credentialEndpointHostVerdict(REST_SHAPED, "https://mcp.vendor.com/sse").allowed,
  "🔴 §1 a REST-shaped rule's pathPrefixes/methods do NOT leak into the host-only check — a legitimate MCP path outside the REST prefix still passes on host alone",
);
ok(!credentialEndpointHostVerdict(HOSTS_ONLY, "not a url").allowed, "§1 an unparseable URL is refused rather than passed through");

assert.doesNotThrow(
  () => assertCredentialEndpointHostAllowed(HOSTS_ONLY, "https://mcp.vendor.com/mcp", "w"),
  "an allowed transport URL must not throw",
);
n++;
{
  let thrown: unknown;
  try {
    assertCredentialEndpointHostAllowed(HOSTS_ONLY, "https://evil.example.com/mcp", 'connection "vendor" credential "team"');
  } catch (e) {
    thrown = e;
  }
  ok(thrown instanceof CredentialEndpointError, "§1 a refusal throws CredentialEndpointError, matching the REST guard's error type");
  const msg = thrown instanceof Error ? thrown.message : "";
  ok(msg.includes("team") && msg.includes("vendor"), "§1 the message names which connection + credential was refused");
  ok(msg.includes("evil.example.com"), "§1 the message names the refused URL");
}

const BOUND_REF = "ope523:bound";
const BROKER = "ope523-test";
let asked: string[] = [];
const probeBroker: CredentialBroker = {
  async getSecret(ref: string) {
    asked.push(ref);
    return `secret-for-${ref}`;
  },
};
registerBroker(BROKER, probeBroker);

const RIGHT_URL = "https://mcp.vendor.com/mcp";
const WRONG_URL = "https://evil.example.com/mcp";
const boundCred = {
  connector: "vendor",
  credential: "team",
  type: "api-key" as const,
  grantFamily: "install" as const,
  principal: "app" as const,
  secretRef: BOUND_REF,
  broker: BROKER,
  endpoints: HOSTS_ONLY,
};

asked = [];
{
  const r = await resolveAppTokenFromCred({ connector: "vendor", directUrl: RIGHT_URL }, boundCred, undefined);
  ok(r.token === `secret-for-${BOUND_REF}`, "§2 positive control: right host → token resolves");
  ok(asked.join(",") === BOUND_REF, "§2 …the broker WAS reached");
}

asked = [];
{
  await assert.rejects(
    () => resolveAppTokenFromCred({ connector: "vendor", directUrl: WRONG_URL }, boundCred, undefined),
    (e: unknown) => e instanceof CredentialEndpointError,
    "a wrong-host directUrl must reject with CredentialEndpointError",
  );
  n++;
  ok(asked.length === 0, "🔴 §2 ACCEPTANCE: the broker was NEVER reached on a wrong-host directUrl — the secret never left the resolver");
}

asked = [];
{
  const r = await resolveAppTokenFromCred({ connector: "vendor" }, boundCred, undefined);
  ok(r.token === `secret-for-${BOUND_REF}`, "§2 NEGATIVE CONTROL: no directUrl supplied ⇒ no host check runs, byte-identical to pre-OPE-523 behaviour");
}

asked = [];
{
  const unnarrowedCred = { ...boundCred, endpoints: undefined };
  const r = await resolveAppTokenFromCred({ connector: "vendor", directUrl: WRONG_URL }, unnarrowedCred, undefined);
  ok(r.token === `secret-for-${BOUND_REF}`, "§2 NEGATIVE CONTROL: a credential declaring no endpoint rules is unnarrowed even against a mismatched directUrl");
}

resetBrokers();

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineConnectorCredentials, vercelConnectorHome } = await import("../agent/access/connector-credentials.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");

registerConfig({
  loadConnectorCredentials: () => [
    defineConnectorCredentials({
      connector: "vendor",
      allows: ["user-oauth"],
      credentials: [
        { id: "mine", type: "user-oauth", home: vercelConnectorHome("oauth/vendor-user"), endpoints: HOSTS_ONLY },
      ],
    }),
  ],
  loadBundles: () => [
    defineBundle({ name: "personal", connectors: [{ name: "vendor", credential: "mine", contentOrigin: "external" }] }),
  ],
  loadBindings: () => [defineBinding({ bundle: "personal", scope: { level: "principal", principal: "slack/T_TEAM/U_caller" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

registerSettings({ connectors: { userPrincipal: true } });

function slackAuth(attrs: Record<string, string>) {
  const p = {
    principalType: "service",
    principalId: attrs.user_id,
    authenticator: "slack",
    attributes: { team_id: "T_TEAM", is_private: "false", ...attrs },
  };
  return { current: p, initiator: p };
}
const dmAuth = slackAuth({ channel_id: "D_DM", channel_type: "im", user_id: "U_caller" });

interface MintCall {
  connector: string;
  id: string;
}
function makeMinter() {
  const calls: MintCall[] = [];
  const mint = async (connector: string, params: { subject: { id: string } }) => {
    calls.push({ connector, id: params.subject.id });
    return { token: `USER-TOKEN-${params.subject.id}` };
  };
  return { calls, mint };
}
const notInjectedStarter = {
  start: async () => {
    throw new Error("startAuthorization not-injected");
  },
};

async function getUserToken(directUrl: string | undefined, minter: ReturnType<typeof makeMinter>): Promise<{ token?: string; err?: string }> {
  const resolver = userAwareProviderToken(
    { connector: "vendor", directUrl },
    { mintUser: minter.mint, startAuth: notInjectedStarter.start as never },
  );
  const provider = await resolver({ session: { auth: dmAuth } } as never);
  try {
    const getToken = provider.getToken as (o: unknown) => Promise<{ token: string }>;
    const r = await getToken(undefined);
    return { token: r.token };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

{
  const m = makeMinter();
  const r = await getUserToken(RIGHT_URL, m);
  ok(r.token !== undefined && r.token.startsWith("USER-TOKEN-"), "§3 positive control: right directUrl → the per-user mint reaches and returns a token");
  ok(m.calls.length === 1, "§3 …the mint WAS reached exactly once");
}

{
  const m = makeMinter();
  const r = await getUserToken(WRONG_URL, m);
  ok(r.token === undefined && r.err !== undefined, "🔴 §3 ACCEPTANCE: a wrong-host directUrl on the user-oauth branch refuses (getToken throws, no token)");
  ok((r.err ?? "").includes("evil.example.com"), "§3 the refusal names the refused URL");
  ok(m.calls.length === 0, "🔴 §3 ACCEPTANCE: the per-user mint was NEVER called on a wrong-host directUrl — no personal token is minted against a mismatched connection");
}

{
  const m = makeMinter();
  const r = await getUserToken(undefined, m);
  ok(r.token !== undefined, "§3 NEGATIVE CONTROL: no directUrl supplied ⇒ no host check runs on the user-oauth branch either");
  ok(m.calls.length === 1, "§3 …the mint still reaches normally");
}

resetSettingsForTest();
rmSync(tmp, { recursive: true, force: true });
console.log(`connector-transport-host-fence-test: ${n} assertions passed`);
