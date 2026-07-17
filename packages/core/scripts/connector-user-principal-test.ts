import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-user-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_CONNECTOR_DM_ONLY;
delete process.env.OE_ORG;
process.env.OE_PLATFORM = "slack";
process.env.NOTION_API_KEY = "STATIC-TEAM-KEY";

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineProvider } = await import("../agent/access/providers.js");

registerConfig({
  loadProviders: () => [
    defineProvider({
      name: "notion",
      connection: "notion",
      allows: ["api-key", "service-oauth", "user-oauth"],
      credentials: [{ id: "mine", type: "user-oauth", vercelConnector: "oauth/notion-user" }],
    }),
  ],
  loadBundles: () => [
    defineBundle({ name: "svc", connectors: ["notion"] }),
    defineBundle({ name: "personal", providers: [{ provider: "notion", credential: "mine" }] }),
  ],
  loadBindings: () => [
    defineBinding({ bundle: "svc", scope: { level: "org" } }),
    defineBinding({ bundle: "personal", scope: { level: "workspace", workspace: "dm:U_caller" } }),
  ],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { userAwareProviderToken } = await import("../agent/connections/connector-auth.js");
const {
  connectorUserPrincipalEnabled,
  OE_CONNECTOR_USER_PRINCIPAL_ENV,
} = await import("../agent/connections/connector-flags.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

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
const channelAuth = slackAuth({ channel_id: "C_CHAN", channel_type: "channel", user_id: "U_caller" });

interface MintCall { connector: string; id: string }
function makeMinter(mode: "ok" | "auth-required") {
  const calls: MintCall[] = [];
  const mint = async (connector: string, params: { subject: { id: string } }) => {
    calls.push({ connector, id: params.subject.id });
    if (mode === "auth-required") {
      const e = new Error("user_authorization_required");
      e.name = "UserAuthorizationRequiredError";
      throw e;
    }
    return { token: `USER-TOKEN-${params.subject.id}` };
  };
  return { calls, mint };
}

async function getToken(auth: unknown, minter: ReturnType<typeof makeMinter>): Promise<{ token?: string; err?: string }> {
  const resolver = userAwareProviderToken({ connector: "notion", fallbackSecretRef: "NOTION_API_KEY" }, { mintUser: minter.mint });
  const provider = await resolver({ session: { auth } } as never);
  try {
    const getToken = provider.getToken as (o: unknown) => Promise<{ token: string }>;
    const r = await getToken(undefined);
    return { token: r.token };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

delete process.env[OE_CONNECTOR_USER_PRINCIPAL_ENV];
ok(!connectorUserPrincipalEnabled(), "OE_CONNECTOR_USER_PRINCIPAL unset → OFF (default, flag-off byte-identical)");
process.env[OE_CONNECTOR_USER_PRINCIPAL_ENV] = "1";
ok(connectorUserPrincipalEnabled(), 'OE_CONNECTOR_USER_PRINCIPAL="1" → ON');
delete process.env[OE_CONNECTOR_USER_PRINCIPAL_ENV];

{
  const m = makeMinter("ok");
  const r = await getToken(dmAuth, m);
  ok(r.token === "USER-TOKEN-U_caller", "DM → mints a per-user token via the injected minter");
  ok(m.calls.length === 1 && m.calls[0].connector === "oauth/notion-user" && m.calls[0].id === "U_caller", "mint used the user-oauth vercelConnector + subject id = surface principal");
}

{
  const m = makeMinter("auth-required");
  const r = await getToken(dmAuth, m);
  ok(r.token === undefined && !!r.err, "DM + UserAuthorizationRequired → getToken throws (no token)");
  ok(/connect|authoriz/i.test(r.err ?? ""), "the error is the actionable 'connect/authorize your account' message");
  ok(!/user_authorization_required/i.test(r.err ?? ""), "the raw SDK error is NOT surfaced to the model");
}

{
  const m = makeMinter("ok");
  const r = await getToken(channelAuth, m);
  ok(r.token === undefined && /DM-only/.test(r.err ?? ""), "channel + wall ON → refused DM-only (A1 composes with the re-armed wall)");
  ok(m.calls.length === 0, "A1 mints NOTHING on a non-DM seat — the wall fires first, minter never called");
}

{
  process.env.OE_CONNECTOR_DM_ONLY = "0";
  const m = makeMinter("ok");
  const r = await getToken(channelAuth, m);
  ok(r.token === "STATIC-TEAM-KEY", "channel + wall OFF → falls through to the app fallback key (universe gate blocks user-oauth on a channel)");
  ok(m.calls.length === 0, "still no per-user mint on a channel even with the wall disarmed");
  delete process.env.OE_CONNECTOR_DM_ONLY;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ connector-user-principal: ${passed} assertions passed`);
