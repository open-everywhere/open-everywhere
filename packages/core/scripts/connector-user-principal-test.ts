import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";
import { setPlatformStandInForTest } from "../agent/identity/binding.js";
registerSlackFixtureMapper();


const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-user-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
setPlatformStandInForTest("slack");
process.env.NOTION_API_KEY = "STATIC-TEAM-KEY";
process.env.NOTION_TEAM = "BOUND-TEAM-KEY";

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineConnectorCredentials, vercelConnectorHome } = await import("../agent/access/connector-credentials.js");

registerConfig({
  loadConnectorCredentials: () => [
    defineConnectorCredentials({
      connector: "notion",
      allows: ["api-key", "service-oauth", "user-oauth"],
      credentials: [
        { id: "mine", type: "user-oauth", home: vercelConnectorHome("oauth/notion-user") },
        { id: "team", type: "api-key", secretRef: "NOTION_TEAM", broker: "env" },
      ],
    }),
  ],
  loadBundles: () => [
    defineBundle({ name: "svc", connectors: [{ name: "notion", credential: "team", contentOrigin: "external" }] }),
    defineBundle({ name: "personal", connectors: [{ name: "notion", credential: "mine", contentOrigin: "external" }] }),
  ],
  loadBindings: () => [
    defineBinding({ bundle: "svc", scope: { level: "org" } }),
    defineBinding({ bundle: "personal", scope: { level: "principal", principal: "slack/T_TEAM/U_caller" } }),
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
  connectorLinkSetVaultEnabled,
} = await import("../agent/connections/connector-flags.js");
const { overrideSettingsForTest, registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { sharedVaultSubject, rawVaultSubject } = await import("../agent/identity/oauth-vault-share.js");
const { setLinkSetHold, revokeLinkSet } = await import("../agent/identity/link-store.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");

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

const RAW = rawVaultSubject(deploymentOrg(), "slack", "T_TEAM", "U_caller");

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

interface StartCall { connector: string; id: string; expiresInMs?: number }
function makeStarter(mode: "ok" | "fail", url = "https://connect.vercel.com/auth/PERSONAL-LINK") {
  const calls: StartCall[] = [];
  const start = async (
    connector: string,
    params: { subject: { id: string } },
    options: { expiresInMs?: number },
  ) => {
    calls.push({ connector, id: params.subject.id, expiresInMs: options.expiresInMs });
    if (mode === "fail") throw new Error("startAuthorization failed (no OIDC session)");
    return { url };
  };
  return { calls, start };
}
const notInjectedStarter = { calls: [] as StartCall[], start: async () => { throw new Error("startAuthorization not-injected"); } };

async function getToken(
  auth: unknown,
  minter: ReturnType<typeof makeMinter>,
  starter: { start: (...a: never[]) => Promise<{ url: string }> } = notInjectedStarter,
): Promise<{ token?: string; err?: string }> {
  const resolver = userAwareProviderToken(
    { connector: "notion", fallbackSecretRef: "NOTION_API_KEY", fallbackBroker: "env" },
    { mintUser: minter.mint, startAuth: starter.start as never },
  );
  const provider = await resolver({ session: { auth } } as never);
  try {
    const getToken = provider.getToken as (o: unknown) => Promise<{ token: string }>;
    const r = await getToken(undefined);
    return { token: r.token };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(k: { name: string }): T | undefined { return this.store.get(k.name) as T | undefined; }
  has(k: { name: string }): boolean { return this.store.has(k.name); }
  require<T>(k: { name: string }): T { if (!this.has(k)) throw new Error(`missing ${k.name}`); return this.get(k) as T; }
  set<T>(k: { name: string }, v: T | ((c: T | undefined) => T)): T { const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(k)) : v; this.store.set(k.name, next); return next; }
  ensure<T>(k: { name: string }, create: () => T): T { return this.has(k) ? this.require(k) : this.set(k, create()); }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}
function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

resetSettingsForTest();
ok(connectorUserPrincipalEnabled(), "🔴 connectors.userPrincipal unregistered → ON (the shipped default since OPE-2414: a DM signs in as the person)");
registerSettings({ connectors: { userPrincipal: false } });
ok(!connectorUserPrincipalEnabled(), "connectors.userPrincipal: false → OFF (the opt-out)");
resetSettingsForTest();

{
  const m = makeMinter("ok");
  const r = await getToken(dmAuth, m);
  ok(r.token === `USER-TOKEN-${RAW}`, "DM → mints a per-user token via the injected minter");
  ok(m.calls.length === 1 && m.calls[0].connector === "oauth/notion-user" && m.calls[0].id === RAW, "mint used the user-oauth vercelConnector + subject id = the caller's QUALIFIED subject");
  ok(m.calls[0].id !== "U_caller", "🔴 the vault subject is NOT the bare native id — the spelling OPE-286 deleted");
  ok(m.calls[0].id.startsWith("p:") && m.calls[0].id.endsWith("/slack/T_TEAM/U_caller"), "the raw subject carries its own prefix + the platform from the BINDING (never sniffed from the id's shape)");
  ok(rawVaultSubject(deploymentOrg(), "slack", "T_TEAM", "U_caller") !== rawVaultSubject("other-org", "slack", "T_TEAM", "U_caller"), "🔴 same native id, different org → different vault subject (no cross-tenant alias)");
  ok(rawVaultSubject(deploymentOrg(), "slack", "T_TEAM", "U_caller") !== rawVaultSubject(deploymentOrg(), "discord", undefined, "U_caller"), "🔴 same native id, different platform → different vault subject (no cross-vendor alias)");
  ok(!m.calls[0].id.startsWith("ls:"), "🔴 a raw subject can never take the SHARED (ls:) shape — the two producers use disjoint prefixes");
  ok(!rawVaultSubject(deploymentOrg(), "slack", "T_TEAM", "ls:evil/x").startsWith("ls:"), "🔴 a native id CRAFTED as 'ls:evil/x' still composes a raw subject — it cannot be mistaken for a link-set's shared row");
  ok(!sharedVaultSubject(deploymentOrg(), "S_evil").startsWith("p:"), "🔴 …and a shared subject can never take the raw shape either (disjoint in both directions)");
}

{
  const m = makeMinter("auth-required");
  const s = makeStarter("ok");
  const r = await getToken(dmAuth, m, s);
  ok(r.token === undefined && !!r.err, "DM + UserAuthorizationRequired → getToken throws (no token)");
  ok(/connect|authoriz/i.test(r.err ?? ""), "the error is the actionable 'connect/authorize your account' message");
  ok(!/user_authorization_required/i.test(r.err ?? ""), "the raw SDK error is NOT surfaced to the model");
  ok((r.err ?? "").includes("https://connect.vercel.com/auth/PERSONAL-LINK"), "the minted PERSONAL authorization URL appears in the relayed error");
  ok(/expires/i.test(r.err ?? "") && /YOU with YOUR own access/.test(r.err ?? ""), "keeps the personal + expiry framing (link is personal, acts as YOU)");
  ok(s.calls.length === 1 && s.calls[0].connector === "oauth/notion-user" && s.calls[0].id === RAW, "#112: startAuthorization used the user-oauth vercelConnector + the SAME qualified subject the mint would use (threat j)");
  ok(typeof s.calls[0].expiresInMs === "number" && (s.calls[0].expiresInMs ?? 0) > 0 && (s.calls[0].expiresInMs ?? 0) <= 20 * 60 * 1000, "a short (~15 min) TTL is passed to the mint");
}

{
  const m = makeMinter("auth-required");
  const s = makeStarter("fail");
  const r = await getToken(dmAuth, m, s);
  ok(r.token === undefined && /authoriz/i.test(r.err ?? ""), "URL mint failure still throws the auth-required 'connect your account' error");
  ok(!/https?:\/\//.test(r.err ?? ""), "startAuthorization failure → falls back to the no-URL copy (never masks the auth-required signal)");
  ok(s.calls.length === 1, "the URL mint was attempted exactly once before degrading");
}

await eveContextStorage().run(new FakeSession(), async () => {
  const m = makeMinter("auth-required");
  const s = makeStarter("ok", "https://connect.vercel.com/auth/ONE-SHOT");
  const r1 = await getToken(dmAuth, m, s);
  ok((r1.err ?? "").includes("https://connect.vercel.com/auth/ONE-SHOT"), "memo: first refusal carries the minted URL");
  const r2 = await getToken(dmAuth, m, s);
  ok((r2.err ?? "").includes("https://connect.vercel.com/auth/ONE-SHOT"), "memo: second same-turn call REPEATS the SAME link (from the cache, not a fresh mint)");
  ok(/not retrying|already failed this turn/i.test(r2.err ?? ""), "memo: the repeat is the deterministic short-circuit error");
  ok(s.calls.length === 1, "memo: startAuthorization minted EXACTLY ONCE per connector per turn");
  ok(m.calls.length === 1, "memo: the token mint was NOT re-hit on the short-circuited retry");
});

await eveContextStorage().run(new FakeSession(), async () => {
  const m = makeMinter("auth-required");
  const s = makeStarter("ok", "https://connect.vercel.com/auth/CHILD-LINK");
  const cards: { recipientId: string; connector: string; url: string }[] = [];
  const resolver = userAwareProviderToken(
    { connector: "notion", fallbackSecretRef: "NOTION_API_KEY", fallbackBroker: "env" },
    {
      mintUser: m.mint,
      startAuth: s.start as never,
      workChild: () => true,
      deliverSignIn: async (o) => {
        cards.push({ recipientId: o.recipientId, connector: o.connector, url: o.url });
        return true;
      },
    },
  );
  const provider = await resolver({ session: { auth: dmAuth } } as never);
  const call = async (): Promise<string> => {
    try {
      await (provider.getToken as (o: unknown) => Promise<unknown>)(undefined);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const first = await call();
  ok(first.startsWith("needs-sign-in:"), `OPE-2340: a work-session child's auth-required call settles needs-sign-in (got: ${first.slice(0, 80)})`);
  ok(!/https?:\/\//.test(first), "🔴 OPE-2340: the needs-sign-in error carries NO link — the child's words reach the room");
  ok(/went to that person directly/.test(first) && /nothing waits/.test(first), "OPE-2340: the error says the card went privately and nothing waits");
  ok(cards.length === 1 && cards[0]!.url === "https://connect.vercel.com/auth/CHILD-LINK" && cards[0]!.recipientId === "U_caller", "OPE-2340: the link went to the asking person's own sign-in card");
  const retry = await call();
  ok(!/https?:\/\//.test(retry), "🔴 OPE-2340: a same-turn retry repeats NO link either (the memo holds no URL)");
  ok(s.calls.length === 1 && cards.length === 1, "OPE-2340: one link mint and one card per connector per turn");
});
{
  const m = makeMinter("auth-required");
  const s = makeStarter("ok", "https://connect.vercel.com/auth/CHILD-LINK-2");
  const resolver = userAwareProviderToken(
    { connector: "notion", fallbackSecretRef: "NOTION_API_KEY", fallbackBroker: "env" },
    { mintUser: m.mint, startAuth: s.start as never, workChild: () => true, deliverSignIn: async () => false },
  );
  const provider = await resolver({ session: { auth: dmAuth } } as never);
  let err = "";
  try {
    await (provider.getToken as (o: unknown) => Promise<unknown>)(undefined);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  ok(err.startsWith("needs-sign-in:") && /could not be delivered privately/.test(err) && !/https?:\/\//.test(err), "OPE-2340: an undelivered card is reported as such, with no link");
}

{
  registerSettings({ connectors: { dmOnly: true, opTiering: false, userPrincipal: false } });
  const m = makeMinter("ok");
  const r = await getToken(channelAuth, m);
  ok(r.token === undefined && /DM-only/.test(r.err ?? ""), "channel + wall ON → refused DM-only (A1 composes with the re-armed wall)");
  ok(m.calls.length === 0, "A1 mints NOTHING on a non-DM seat — the wall fires first, minter never called");
  resetSettingsForTest();
}

{
  resetSettingsForTest();
  const m = makeMinter("ok");
  const r = await getToken(channelAuth, m);
  ok(r.token === "BOUND-TEAM-KEY", "🔴 shipped posture: a channel resolves the app credential the grant NAMES — never the user's");
  ok(m.calls.length === 0, "🔴 shipped posture: no per-user mint on a channel");
}

{
  registerSettings({ connectors: { dmOnly: false } });
  const m = makeMinter("ok");
  const r = await getToken(channelAuth, m);
  ok(r.token === "BOUND-TEAM-KEY", "channel + wall OFF → resolves the app credential the grant NAMES (the universe gate blocks user-oauth on a channel)");
  ok(r.token !== "STATIC-TEAM-KEY", "…and not the connection's own fallback: a named credential outranks it");
  ok(m.calls.length === 0, "still no per-user mint on a channel even with the wall disarmed");
  resetSettingsForTest();
}

{
  resetSettingsForTest();
  ok(connectorLinkSetVaultEnabled(), "🔴 C.3: connectors.linkSetVault unregistered → ON (the shipped default since OPE-2414: one consent covers a person's linked accounts)");
  registerSettings({ connectors: { linkSetVault: false } });

  const org = deploymentOrg();
  const store = getOperationalStore();
  const at = new Date().toISOString();
  const SET = "S_caller";
  await store.putLinkSet(org, { org, id: SET, handle: "the caller", status: "active", createdAt: at, updatedAt: at });
  await store.insertLinkedId(org, { org, platform: "slack", tenant: "T_TEAM", nativeId: "U_caller", linkSetId: SET, status: "confirmed", establishedBy: "test", evidenceJson: undefined, createdAt: at, updatedAt: at });
  const shared = sharedVaultSubject(org, SET);

  {
    const m = makeMinter("ok");
    await getToken(dmAuth, m);
    ok(m.calls[0].id === RAW, "C.3: flag OFF → the caller OWN qualified raw subject even for a confirmed member (deliberate arming; qualified since OPE-286)");
  }

  registerSettings({ connectors: { linkSetVault: true } });
  {
    const m = makeMinter("ok");
    const r = await getToken(dmAuth, m);
    ok(m.calls[0].id === shared && shared.startsWith("ls:") && shared.endsWith(`/${SET}`), "C.3: confirmed DM member → the SHARED link-set subject ls:<org>/<set> with no ratify step (not the raw principal)");
    ok(r.token === `USER-TOKEN-${shared}`, "C.3: the shared subject is what the vault mint receives (same row across the person's linked DMs)");
  }

  await setLinkSetHold({ org, linkSetId: SET, hold: "suspended", actor: "admin" });
  {
    const m = makeMinter("ok");
    await getToken(dmAuth, m);
    ok(m.calls[0].id === RAW, "C.3: suspended set → RAW subject (offboarding severs shared-token reach immediately — threat b)");
  }
  await setLinkSetHold({ org, linkSetId: SET, hold: "active", actor: "admin" });
  {
    const m = makeMinter("ok");
    await getToken(dmAuth, m);
    ok(m.calls[0].id === shared, "C.3: reactivate → sharing restored from the surviving membership");
  }

  {
    overrideSettingsForTest({ connectors: { dmOnly: true, opTiering: false, userPrincipal: false } });
    const m = makeMinter("ok");
    const r = await getToken(channelAuth, m);
    ok(r.token === undefined && /DM-only/.test(r.err ?? "") && m.calls.length === 0, "C.3: channel + wall on → refused DM-only, derivation never reached (threat f)");
    overrideSettingsForTest({ connectors: { dmOnly: false, opTiering: true } });
  }
  {
    const m = makeMinter("ok");
    const r = await getToken(channelAuth, m);
    ok(r.token === "BOUND-TEAM-KEY" && m.calls.length === 0, "C.3: channel on the shipped posture → the app credential, derivation never reached (threat f)");
  }

  await revokeLinkSet({ org, linkSetId: SET, actor: "admin" });
  {
    const m = makeMinter("ok");
    await getToken(dmAuth, m);
    ok(m.calls[0].id === RAW, "C.3: revoke link-set → severed account falls back to RAW subject (threat b)");
  }
  resetSettingsForTest();
}

await removeTempDir(tmp);
console.log(`✓ connector-user-principal: ${passed} assertions passed`);
