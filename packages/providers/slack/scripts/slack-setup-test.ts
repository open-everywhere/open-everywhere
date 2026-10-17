import assert from "node:assert/strict";
import { SLACK_APP_REF_NAMESPACE, type EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";

import { rmSync as __rmSuiteStore } from "node:fs";
import { join as __joinSuiteStore } from "node:path";
import { tmpdir as __tmpdirSuiteStore } from "node:os";
const __suiteStoreDir = __joinSuiteStore(__tmpdirSuiteStore(), `open-everywhere-suite-slack-setup-${process.pid}`);
__rmSuiteStore(__suiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __joinSuiteStore(__suiteStoreDir, "ops.sqlite3");
import {
  SETUP_COOKIE_NAME,
  SETUP_COOKIE_TTL_MS,
  announceSlackSetupCode,
  resetSlackClaimSecretCache,
  resetSlackSetupLockCache,
  mintSetupCookie,
  setupCodeMatches,
  setupCookieFrom,
  setupCookieHeader,
  slackSetupCode,
  slackSetupOpen,
  verifySetupCookie,
} from "../agent/setup/claim.js";
import {
  SLACK_BOT_TOKEN_REF,
  SLACK_CLIENT_SECRET_REF,
  SLACK_COOKIE_KEY_REF,
  SLACK_INSTALL_REF,
  SLACK_PENDING_REF,
  SLACK_PENDING_SIGNING_SECRET_REF,
  SLACK_SETUP_CODE_REF,
  SLACK_SIGNING_SECRET_REF,
  parseInstallState,
  readInstallRecord,
  recordSlackInstall,
  reopenSlackSetup,
  slackInstallState,
} from "../agent/setup/install-state.js";
import {
  SLACK_SETUP_CALLBACK_PATH,
  SLACK_SETUP_PATH,
  handleSlackSetupCallback,
  handleSlackSetupGet,
  handleSlackSetupPost,
} from "../agent/setup/page.js";
import { SlackSetupApiError, createSlackApp, exchangeSlackOauthCode } from "../agent/setup/slack-api-setup.js";
import { slackBotTokenForEve, verifySlackInboundForEve } from "../agent/setup/eve-credentials.js";
import { SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER, slackSignature } from "../agent/channels/slack-signature.js";
import {
  resetSlackCredentialMemo,
  resetSlackCredentialNotices,
  resolveSlackSecret,
  slackBotToken,
  slackSigningSecret,
} from "../agent/setup/credentials.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

console.log("slack setup (OPE-2231):");

function memoryVault(initial: Record<string, string> = {}): EncryptedKvVault & { readonly rows: Map<string, string> } {
  const rows = new Map<string, string>(Object.entries(initial));
  return {
    rows,
    async read(ref) {
      return rows.has(ref) ? (rows.get(ref) as string) : null;
    },
    async write(ref, plaintext) {
      rows.set(ref, plaintext);
    },
    async delete(ref) {
      return rows.delete(ref);
    },
    async listRefs(prefix) {
      if (!prefix) throw new Error("listRefs: prefix required");
      return [...rows.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async withLock(_key, fn) {
      return fn();
    },
    async claim() {
      return true;
    },
    async releaseClaim() {
    },
  };
}

function brokenVault(): EncryptedKvVault {
  const boom = (): never => {
    throw new Error("store unreachable");
  };
  return {
    read: boom,
    write: boom,
    delete: boom,
    listRefs: boom,
    withLock: async <T>(_k: string, fn: () => Promise<T>): Promise<T> => fn(),
    claim: boom,
    releaseClaim: boom,
  } as unknown as EncryptedKvVault;
}

const INSTALLED = JSON.stringify({
  v: 1,
  appId: "A0FAKEAPP",
  clientId: "1111.2222",
  teamId: "T0FAKETEAM",
  teamName: "Fake Workspace",
  installerUserId: "U0FAKEUSER",
  installedAt: "2026-10-02T00:00:00.000Z",
});

const ENV_HOST = { OE_PUBLIC_BASE_URL: "https://oe.example.com" } as NodeJS.ProcessEnv;

const publicHost = async (): Promise<Response> => new Response("ok", { status: 200 });

function depsFor(vault: EncryptedKvVault, extra: Record<string, unknown> = {}) {
  return { vault, env: ENV_HOST, keyArmed: () => true, probeFetch: publicHost, ...extra } as never;
}

function claimDeps(vault: EncryptedKvVault, extra: Record<string, unknown> = {}) {
  return { vault, env: ENV_HOST, ...extra } as never;
}

function get(path = SLACK_SETUP_PATH, cookie?: string): Request {
  return new Request(`https://oe.example.com${path}`, {
    headers: cookie ? { cookie: `${SETUP_COOKIE_NAME}=${cookie}` } : {},
  });
}

function post(body: Record<string, string>, cookie?: string): Request {
  return new Request(`https://oe.example.com${SLACK_SETUP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie: `${SETUP_COOKIE_NAME}=${cookie}` } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

console.log("  1. the claim lock");
{
  const open = memoryVault();
  ok((await slackSetupOpen(claimDeps(open))) === true, "setup is OPEN while no install is recorded");

  const locked = memoryVault({ [SLACK_INSTALL_REF]: INSTALLED });
  ok((await slackSetupOpen(claimDeps(locked))) === false, "setup is LOCKED once an install is recorded");

  const d = depsFor(locked);
  ok((await handleSlackSetupGet(get(), d)).status === 404, "GET /setup 404s when locked");
  ok((await handleSlackSetupPost(post({ a: "claim", c: "anything" }), d)).status === 404, "POST /setup 404s when locked");
  ok((await handleSlackSetupCallback(get(`${SLACK_SETUP_CALLBACK_PATH}?code=x&state=y`), d)).status === 404, "the callback 404s when locked");

  ok((await handleSlackSetupPost(post({ a: "claim", c: await slackSetupCode(claimDeps(locked)) }), d)).status === 404, "the RIGHT code on a locked deployment still 404s");

  const disarmed = depsFor(open, { keyArmed: () => false });
  ok((await handleSlackSetupGet(get(), disarmed)).status === 404, "GET /setup 404s when the credential key is disarmed");
}

{
  const vault = memoryVault();
  const d = depsFor(vault);

  const screen1 = await handleSlackSetupGet(get(), d);
  const body1 = await screen1.text();
  ok(screen1.status === 200 && body1.includes("setup code"), "no cookie renders the CLAIM screen");
  ok(!body1.includes("app configuration token"), "the claim screen does NOT leak the create screen's copy");

  const code = await slackSetupCode(claimDeps(vault));
  ok(!body1.includes(code), "🔴 the claim screen never renders the setup code it is asking for");

  const wrong = await handleSlackSetupPost(post({ a: "claim", c: "not-the-code" }), d);
  ok(wrong.status === 200 && (await wrong.text()).includes("did not match"), "a wrong code re-renders with a verdict");
  ok(wrong.headers.get("set-cookie") === null, "a wrong code sets NO cookie");

  const empty = await handleSlackSetupPost(post({ a: "claim", c: "   " }), d);
  ok(empty.status === 200 && !(await empty.text()).includes("did not match"), "an empty submit re-renders with no verdict");

  const right = await handleSlackSetupPost(post({ a: "claim", c: code }), d);
  const setCookie = right.headers.get("set-cookie") ?? "";
  ok(right.status === 303 && right.headers.get("location") === SLACK_SETUP_PATH, "the right code redirects to /setup");
  ok(setCookie.startsWith(`${SETUP_COOKIE_NAME}=`), "the right code sets the claim cookie");
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax"]) {
    ok(setCookie.includes(attr), `the claim cookie carries ${attr}`);
  }
  ok(!setCookie.includes(code), "🔴 the Set-Cookie header does not carry the setup code");

  ok((await handleSlackSetupPost(post({ a: "create", t: "xoxe-fake" }), d)).status === 404, "a create submit without the cookie 404s");
}

{
  const vault = memoryVault();
  const value = await mintSetupCookie(claimDeps(vault));
  ok(await verifySetupCookie(value, claimDeps(vault)), "a freshly minted cookie verifies");
  ok(!(await verifySetupCookie(`${value}x`, claimDeps(vault))), "a tampered signature is refused");
  ok(!(await verifySetupCookie(value.replace(/^[^.]+/, "eyJ2IjoxLCJleHAiOjF9"), claimDeps(vault))), "a swapped payload is refused");
  ok(!(await verifySetupCookie(undefined, claimDeps(vault))), "a missing cookie is refused");
  ok(!(await verifySetupCookie("", claimDeps(vault))), "an empty cookie is refused");
  ok(!(await verifySetupCookie("no-dot", claimDeps(vault))), "a cookie with no signature is refused");
  ok(!(await verifySetupCookie(value, claimDeps(vault, { now: () => Date.now() + 31 * 60 * 1000 }))), "an expired cookie is refused");

  const other = memoryVault();
  ok(!(await verifySetupCookie(await mintSetupCookie(claimDeps(other)), claimDeps(vault))), "a cookie from another deployment's key is refused");

  ok(setupCookieFrom(get(SLACK_SETUP_PATH, "abc")) === "abc", "the cookie reader finds its own cookie");
  ok(setupCookieFrom(get()) === undefined, "the cookie reader answers undefined with no Cookie header");
  ok(setupCookieHeader("v").includes(`Max-Age=${Math.floor(SETUP_COOKIE_TTL_MS / 1000)}`), "the cookie's Max-Age is derived from the declared TTL");
}

{
  const vault = memoryVault();
  const first = await slackSetupCode(claimDeps(vault));
  const second = await slackSetupCode(claimDeps(vault));
  ok(first === second, "the setup code is minted once and stable");
  ok(vault.rows.get(SLACK_SETUP_CODE_REF) === first, "the setup code is stored under its reserved ref");
  ok(first.length >= 20, "the setup code carries at least 128 bits of entropy");
  ok(await setupCodeMatches(` ${first} `, claimDeps(vault)), "the comparison tolerates surrounding whitespace");
  ok(!(await setupCodeMatches(first.slice(0, -1), claimDeps(vault))), "a truncated code does not match");
  ok(!(await setupCodeMatches(`${first}x`, claimDeps(vault))), "a lengthened code does not match");

  ok((await slackSetupCode(claimDeps(memoryVault()))) !== first, "a different deployment mints a different code");
}

{
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const openVault = memoryVault();
    await announceSlackSetupCode(claimDeps(openVault));
    const code = await slackSetupCode(claimDeps(openVault));
    console.log = realLog;
    ok(lines.some((l) => l.includes(code)), "the boot notice logs the setup code while setup is open");
    ok(
      lines.some((l) => l.includes(`Open ${ENV_HOST.OE_PUBLIC_BASE_URL}${SLACK_SETUP_PATH} and enter`)),
      "the boot notice names the absolute /setup URL on the deployment's public host",
    );

    lines.length = 0;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    await announceSlackSetupCode({ vault: memoryVault(), env: {} as NodeJS.ProcessEnv } as never);
    console.log = realLog;
    ok(lines.some((l) => l.includes("set OE_PUBLIC_BASE_URL to name it")), "with no base URL, the boot notice names OE_PUBLIC_BASE_URL");

    lines.length = 0;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    const lockedVault = memoryVault({ [SLACK_INSTALL_REF]: INSTALLED });
    await announceSlackSetupCode(claimDeps(lockedVault));
    console.log = realLog;
    ok(lines.length === 0, "🔴 the boot notice is SILENT once an install is recorded");
    ok(lockedVault.rows.get(SLACK_SETUP_CODE_REF) === undefined, "a locked deployment does not even mint a code");
  } finally {
    console.log = realLog;
  }
}

{
  resetSlackSetupLockCache();
  ok((await slackSetupOpen(claimDeps(brokenVault()))) === false, "🔴 an unreachable store keeps setup CLOSED (fail closed)");
  resetSlackSetupLockCache();
  for (const bad of ["not json", "null", "[]", '{"v":2,"teamId":"T"}', '{"v":1,"teamId":"T0X"}']) {
    ok((await slackSetupOpen(claimDeps(memoryVault({ [SLACK_INSTALL_REF]: bad })))) === false, `🔴 an unparseable install row keeps setup CLOSED: ${bad}`);
    resetSlackSetupLockCache();
  }
  ok((await slackSetupOpen(claimDeps(memoryVault()))) === true, "an ABSENT row is the one case that opens setup");
  resetSlackSetupLockCache();

  ok((await readInstallRecord({ vault: memoryVault() })).kind === "absent", "readInstallRecord: no row ⇒ absent");
  ok((await readInstallRecord({ vault: brokenVault() })).kind === "unreadable", "readInstallRecord: a throw ⇒ unreadable");
  ok((await readInstallRecord({ vault: memoryVault({ [SLACK_INSTALL_REF]: "not json" }) })).kind === "unreadable", "readInstallRecord: a bad row ⇒ unreadable");
  ok((await readInstallRecord({ vault: memoryVault({ [SLACK_INSTALL_REF]: INSTALLED }) })).kind === "present", "readInstallRecord: a good row ⇒ present");

  ok((await slackInstallState(claimDeps(brokenVault()))) === undefined, "the status seam still reads an unreachable store as no install");
  for (const bad of ["not json", "null", "[]", '{"v":2,"teamId":"T"}', '{"v":1,"teamId":"T0X"}']) {
    ok(parseInstallState(bad) === undefined, `a malformed install record is refused: ${bad}`);
  }
  ok(parseInstallState(INSTALLED)?.teamId === "T0FAKETEAM", "a well-formed install record parses");
  resetSlackSetupLockCache();
}

console.log("  2. apps.manifest.create");

const MANIFEST_OK = {
  ok: true,
  app_id: "A0FAKEAPP",
  oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=1111.2222",
  credentials: {
    client_id: "1111.2222",
    client_secret: "fake-client-secret",
    signing_secret: "fake-signing-secret",
    verification_token: "fake-verification-token",
  },
};

{
  const calls: unknown[] = [];
  const created = await createSlackApp(
    { configToken: "xoxe-fake-config-token", manifest: '{"display_information":{"name":"X"}}' },
    {
      call: async (input) => {
        calls.push(input);
        return MANIFEST_OK;
      },
    },
  );
  ok(created.appId === "A0FAKEAPP", "the app id comes back");
  ok(created.clientId === "1111.2222" && created.clientSecret === "fake-client-secret", "the client credentials come back");
  ok(created.signingSecret === "fake-signing-secret", "the signing secret comes back");

  const call = calls[0] as { botToken?: string; operation: string; body: Record<string, unknown> };
  ok(call.operation === "apps.manifest.create", "the operation is apps.manifest.create");
  ok(call.botToken === "xoxe-fake-config-token", "the CONFIG token is the bearer for this one call");
  ok(call.body.manifest === '{"display_information":{"name":"X"}}', "the manifest rides the body verbatim");

  for (const [res, code] of [
    [{ ok: false, error: "token_expired" }, "token_expired"],
    [{ ok: false, error: "invalid_manifest" }, "invalid_manifest"],
    [{ ok: false }, "unknown_error"],
  ] as const) {
    const err = await createSlackApp({ configToken: "t", manifest: "{}" }, { call: async () => res }).then(
      () => undefined,
      (e: unknown) => e,
    );
    ok(err instanceof SlackSetupApiError && err.code === code, `an ok:false answer raises ${code}`);
  }

  const missing = await createSlackApp(
    { configToken: "t", manifest: "{}" },
    { call: async () => ({ ok: true, app_id: "A1", oauth_authorize_url: "u", credentials: { client_id: "c" } }) },
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  ok(missing instanceof SlackSetupApiError && missing.code === "missing_field:client_secret", "a missing credential field is named");

  const threw = await createSlackApp(
    { configToken: "t", manifest: "{}" },
    {
      call: async () => {
        throw new Error("boom: fake-client-secret leaked in an error");
      },
    },
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  ok(threw instanceof SlackSetupApiError && threw.code === "request_failed", "a transport failure is request_failed");
  ok(threw instanceof Error && !threw.message.includes("fake-client-secret"), "🔴 a transport failure's message carries nothing from the caught error");
}

{
  const vault = memoryVault();
  const cookie = await mintSetupCookie(claimDeps(vault));
  let sentManifest = "";
  const res = await handleSlackSetupPost(
    post({ a: "create", t: "xoxe-fake-config-token" }, cookie),
    depsFor(vault, {
      createApp: async (input: { manifest: string }) => {
        sentManifest = input.manifest;
        return {
          appId: "A0FAKEAPP",
          clientId: "1111.2222",
          clientSecret: "fake-client-secret",
          signingSecret: "fake-signing-secret",
          oauthAuthorizeUrl: "https://slack.com/oauth/v2/authorize?client_id=1111.2222",
        };
      },
    }),
  );
  ok(res.status === 303, "a successful create redirects back to /setup");
  ok(vault.rows.get(SLACK_CLIENT_SECRET_REF) === "fake-client-secret", "the client secret is stored");
  ok(vault.rows.get(SLACK_PENDING_SIGNING_SECRET_REF) === "fake-signing-secret", "the new signing secret is STAGED");
  ok(vault.rows.get(SLACK_SIGNING_SECRET_REF) === undefined, "🔴 the LIVE signing secret ref is NOT written at the create step");

  const pending = JSON.parse(vault.rows.get(SLACK_PENDING_REF) ?? "{}") as Record<string, unknown>;
  ok(pending.appId === "A0FAKEAPP" && pending.clientId === "1111.2222", "the pending record names the app");
  ok(typeof pending.state === "string" && (pending.state as string).length >= 20, "the pending record carries a CSRF nonce");
  const pendingRaw = vault.rows.get(SLACK_PENDING_REF) ?? "";
  ok(!pendingRaw.includes("fake-client-secret"), "🔴 the pending record carries NO client secret");
  ok(!pendingRaw.includes("xoxe-fake-config-token"), "🔴 the pending record carries no config token");

  for (const [ref, value] of vault.rows) {
    ok(!value.includes("xoxe-fake-config-token"), `🔴 the config token is not stored under ${ref}`);
  }
  ok((await vault.listRefs("slack-app:")).every((r) => r !== "slack-app:config_token"), "there is no config-token ref at all");

  ok(sentManifest.includes("oe.example.com"), "the manifest carries the deployment's own host");
  ok(!sentManifest.includes("YOUR-DEPLOY-URL"), "🔴 no unsubstituted host placeholder reaches Slack");
  ok(sentManifest.includes(`https://oe.example.com${SLACK_SETUP_CALLBACK_PATH}`), "the manifest declares the OAuth redirect back to this deployment");

  const screen3 = await handleSlackSetupGet(get(SLACK_SETUP_PATH, cookie), depsFor(vault));
  const body3 = await screen3.text();
  ok(body3.includes("Install to Slack"), "a pending app renders the INSTALL screen");
  ok(body3.includes("client_id=1111.2222"), "the install link names the app's client id");
  ok(body3.includes(encodeURIComponent(pending.state as string)) || body3.includes(pending.state as string), "the install link carries the CSRF nonce");
  ok(!body3.includes("fake-client-secret") && !body3.includes("fake-signing-secret"), "🔴 the install screen renders no secret");

  const hasMcpConnect = (html: string): boolean => html.includes("mcp%3Aconnect") || html.includes("mcp:connect");
  ok(!hasMcpConnect(body3), "the install link requests no mcp:connect when the app declares no Slack-as-you entry");
  const { defineMcpServers } = await import("@open-everywhere/core/agent/adapter-api.js");
  const { slackAsYou } = await import("../agent/slack-as-you.js");
  defineMcpServers([slackAsYou({ clientId: "1111.2222" })]);
  try {
    const screen3b = await handleSlackSetupGet(get(SLACK_SETUP_PATH, cookie), depsFor(vault));
    ok(hasMcpConnect(await screen3b.text()), "🔴 OPE-2421: with the entry declared, the install link requests mcp:connect, as the manifest does");
  } finally {
    defineMcpServers([]);
  }
}

{
  const { overrideSettingsForTest, resetSettingsForTest } = await import("@open-everywhere/core/agent/adapter-api.js");
  overrideSettingsForTest({ identity: { name: "Aria", commandName: "aria" } });
  try {
    type Sent = {
      display_information: { name: string };
      features: { bot_user: { display_name: string }; slash_commands: { command: string }[]; shortcuts: { name: string }[] };
    };
    const createVia = async (fields: Record<string, string>): Promise<Sent> => {
      const vault = memoryVault();
      const cookie = await mintSetupCookie(claimDeps(vault));
      let sent = "";
      await handleSlackSetupPost(
        post(fields, cookie),
        depsFor(vault, {
          createApp: async (input: { manifest: string }) => {
            sent = input.manifest;
            return {
              appId: "A0FAKEAPP",
              clientId: "1111.2222",
              clientSecret: "fake-client-secret",
              signingSecret: "fake-signing-secret",
              oauthAuthorizeUrl: "https://slack.com/oauth/v2/authorize?client_id=1111.2222",
            };
          },
        }),
      );
      return JSON.parse(sent) as Sent;
    };
    const named = await createVia({ a: "create", t: "xoxe-fake-config-token" });
    ok(named.display_information.name === "Aria" && named.features.bot_user.display_name === "Aria", "🔴 /setup: the created app is named with the configured identity.name");
    ok(named.features.slash_commands[0]?.command === "/aria", "🔴 /setup: the created app's slash command is the configured identity.commandName");
    ok(named.features.shortcuts.every((sc) => sc.name.includes("Aria")), "/setup: …and both shortcuts name the agent");
    const explicit = await createVia({ a: "create", t: "xoxe-fake-config-token", n: "Acme Agent" });
    ok(explicit.display_information.name === "Acme Agent", "/setup: the form's explicit app name still OVERRIDES the configured name");
    const claim = await (await handleSlackSetupGet(get(SLACK_SETUP_PATH), depsFor(memoryVault()))).text();
    ok(claim.includes("Set up Aria") && !claim.includes("Open Everywhere"), "/setup: the page names the configured agent, not the brand");
  } finally {
    resetSettingsForTest();
  }
}

{
  const vault = memoryVault();
  const cookie = await mintSetupCookie(claimDeps(vault));
  const res = await handleSlackSetupPost(
    post({ a: "create", t: "xoxe-expired" }, cookie),
    depsFor(vault, {
      createApp: async () => {
        throw new SlackSetupApiError("apps.manifest.create", "token_expired");
      },
    }),
  );
  ok(res.status === 400 && (await res.text()).includes("token_expired"), "a refused create shows Slack's code");
  ok(vault.rows.get(SLACK_PENDING_REF) === undefined, "a refused create writes no pending record");
  ok(vault.rows.get(SLACK_CLIENT_SECRET_REF) === undefined, "a refused create stores no credential");

  let called = false;
  const emptyRes = await handleSlackSetupPost(
    post({ a: "create", t: "  " }, cookie),
    depsFor(vault, {
      createApp: async () => {
        called = true;
        throw new Error("should not be called");
      },
    }),
  );
  ok(emptyRes.status === 200 && !called, "an empty config token does not reach Slack");

  const longName = await handleSlackSetupPost(
    post({ a: "create", t: "xoxe-fake", n: "x".repeat(40) }, cookie),
    depsFor(vault, { createApp: async () => { throw new Error("should not be called"); } }),
  );
  ok(longName.status === 400 && (await longName.text()).includes("app name"), "an over-long app name is refused by name");
}

console.log("  3. the OAuth callback");

const OAUTH_OK = {
  ok: true,
  access_token: "xoxb-fake-bot-token",
  team: { id: "T0FAKETEAM", name: "Fake Workspace" },
  authed_user: { id: "U0FAKEUSER", access_token: "xoxp-fake-USER-token" },
};

{
  const calls: Array<Record<string, unknown>> = [];
  const install = await exchangeSlackOauthCode(
    { clientId: "1111.2222", clientSecret: "fake-client-secret", code: "fake-code", redirectUri: "https://oe.example.com/setup/callback" },
    {
      call: async (input) => {
        calls.push(input as Record<string, unknown>);
        return OAUTH_OK;
      },
    },
  );
  ok(install.botToken === "xoxb-fake-bot-token", "🔴 the BOT token is taken from access_token");
  ok(install.botToken !== "xoxp-fake-USER-token", "🔴 the installer's USER token is never taken");
  ok(install.teamId === "T0FAKETEAM" && install.teamName === "Fake Workspace", "the workspace is recorded");
  ok(install.installerUserId === "U0FAKEUSER", "the installer is recorded");

  const call = calls[0] as { unauthenticated?: boolean; operation: string; body: Record<string, unknown>; botToken?: string };
  ok(call.operation === "oauth.v2.access", "the operation is oauth.v2.access");
  ok(call.unauthenticated === true, "🔴 oauth.v2.access is sent with NO Authorization header");
  ok(call.botToken === undefined, "oauth.v2.access passes no bot token");
  ok(call.body.client_id === "1111.2222" && call.body.client_secret === "fake-client-secret", "the client credentials ride the BODY");
  ok(call.body.redirect_uri === "https://oe.example.com/setup/callback", "the redirect_uri is echoed for Slack's own comparison");

  for (const [res, code] of [
    [{ ok: false, error: "invalid_code" }, "invalid_code"],
    [{ ok: true, access_token: "x", authed_user: { id: "U" } }, "missing_field:team"],
    [{ ok: true, access_token: "x", team: { id: "T" } }, "missing_field:authed_user"],
  ] as const) {
    const err = await exchangeSlackOauthCode({ clientId: "c", clientSecret: "s", code: "k", redirectUri: "r" }, { call: async () => res }).then(
      () => undefined,
      (e: unknown) => e,
    );
    ok(err instanceof SlackSetupApiError && err.code === code, `the exchange raises ${code}`);
  }
}

async function pendingVault(): Promise<{ vault: ReturnType<typeof memoryVault>; cookie: string; state: string }> {
  const vault = memoryVault();
  await slackSetupCode(claimDeps(vault));
  const cookie = await mintSetupCookie(claimDeps(vault));
  await handleSlackSetupPost(
    post({ a: "create", t: "xoxe-fake" }, cookie),
    depsFor(vault, {
      createApp: async () => ({
        appId: "A0FAKEAPP",
        clientId: "1111.2222",
        clientSecret: "fake-client-secret",
        signingSecret: "fake-signing-secret",
        oauthAuthorizeUrl: "https://slack.com/oauth/v2/authorize",
      }),
    }),
  );
  const state = (JSON.parse(vault.rows.get(SLACK_PENDING_REF) as string) as { state: string }).state;
  return { vault, cookie, state };
}

{
  const { vault, cookie, state } = await pendingVault();
  ok(vault.rows.get(SLACK_SETUP_CODE_REF) !== undefined, "precondition: the setup code exists before the install");
  ok(vault.rows.get(SLACK_COOKIE_KEY_REF) !== undefined, "precondition: the claim cookie key exists before the install");
  let exchanged: Record<string, unknown> | undefined;
  const res = await handleSlackSetupCallback(
    get(`${SLACK_SETUP_CALLBACK_PATH}?code=fake-code&state=${encodeURIComponent(state)}`, cookie),
    depsFor(vault, {
      exchangeCode: async (input: Record<string, unknown>) => {
        exchanged = input;
        return { botToken: "xoxb-fake-bot-token", teamId: "T0FAKETEAM", teamName: "Fake Workspace", installerUserId: "U0FAKEUSER" };
      },
    }),
  );
  const body = await res.text();
  ok(res.status === 200, "a good callback renders the DONE screen");
  ok(exchanged?.clientSecret === "fake-client-secret", "the callback reads the stored client secret to exchange the code");
  ok(vault.rows.get(SLACK_BOT_TOKEN_REF) === "xoxb-fake-bot-token", "the bot token is stored");
  ok(vault.rows.get(SLACK_SIGNING_SECRET_REF) === "fake-signing-secret", "the callback PROMOTES the staged signing secret to the live ref");
  ok(vault.rows.get(SLACK_PENDING_SIGNING_SECRET_REF) === undefined, "…and clears the staging ref");

  const recorded = await slackInstallState(claimDeps(vault));
  ok(recorded?.teamId === "T0FAKETEAM" && recorded.installerUserId === "U0FAKEUSER", "the install is recorded");
  ok(recorded?.appId === "A0FAKEAPP", "the recorded install names the app the pending record did");

  const recordRaw = vault.rows.get(SLACK_INSTALL_REF) ?? "";
  for (const secret of ["fake-client-secret", "fake-signing-secret", "xoxb-fake-bot-token"]) {
    ok(!recordRaw.includes(secret), `🔴 the install record carries no ${secret.slice(0, 12)}…`);
  }

  const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  ok(body.includes(esc('defineSurface({ key: "slack/T0FAKETEAM", trust: "internal" }),')), "the done screen gives the filled-in vouch line");
  ok(body.includes(esc('admins: ["slack/T0FAKETEAM/U0FAKEUSER"],')), "the done screen gives the filled-in admins line");
  ok(body.includes("&quot;slack/T0FAKETEAM&quot;"), "the rendered config lines are HTML-escaped");
  ok(body.includes("agent/identity/surfaces.ts") && body.includes("agent/memory/config/domains/org.ts"), "the done screen names both files to edit");
  ok(body.includes("make the two edits by hand and push"), "the done screen says to make the edits by hand");
  ok(!body.includes("DM the bot") && body.includes("The bot does not change its own admins from chat"), "the done screen does not promise that the bot makes the admin and vouch edits");
  for (const secret of ["fake-client-secret", "fake-signing-secret", "xoxb-fake-bot-token"]) {
    ok(!body.includes(secret), `🔴 the done screen renders no ${secret.slice(0, 12)}…`);
  }

  ok(vault.rows.get(SLACK_PENDING_REF) === undefined, "the pending record is spent");
  ok(vault.rows.get(SLACK_SETUP_CODE_REF) === undefined, "🔴 the install destroys the setup code");
  ok(vault.rows.get(SLACK_COOKIE_KEY_REF) === undefined, "🔴 the install destroys the claim cookie key");
  ok(!(await verifySetupCookie(cookie, claimDeps(vault))), "🔴 the claim cookie from the completed run no longer verifies");
  ok((res.headers.get("set-cookie") ?? "").includes("Max-Age=0"), "the callback clears the claim cookie");

  ok((await handleSlackSetupGet(get(SLACK_SETUP_PATH, cookie), depsFor(vault))).status === 404, "/setup is locked after the install");
}

{
  const { vault, cookie } = await pendingVault();
  let called = false;
  const res = await handleSlackSetupCallback(
    get(`${SLACK_SETUP_CALLBACK_PATH}?code=fake-code&state=not-the-nonce`, cookie),
    depsFor(vault, {
      exchangeCode: async () => {
        called = true;
        throw new Error("should not be called");
      },
    }),
  );
  ok(res.status === 404, "a wrong state 404s");
  ok(!called, "🔴 a wrong state never reaches Slack");
  ok((await slackInstallState(claimDeps(vault))) === undefined, "a wrong state records no install");
  ok(vault.rows.get(SLACK_BOT_TOKEN_REF) === undefined, "a wrong state stores no bot token");
}

{
  const { vault, state } = await pendingVault();
  let called = false;
  const res = await handleSlackSetupCallback(
    get(`${SLACK_SETUP_CALLBACK_PATH}?code=fake-code&state=${encodeURIComponent(state)}`),
    depsFor(vault, { exchangeCode: async () => { called = true; throw new Error("no"); } }),
  );
  ok(res.status === 404 && !called, "a callback with no claim cookie 404s before reaching Slack");
}

{
  const vault = memoryVault();
  const cookie = await mintSetupCookie(claimDeps(vault));
  const res = await handleSlackSetupCallback(get(`${SLACK_SETUP_CALLBACK_PATH}?code=c&state=s`, cookie), depsFor(vault));
  ok(res.status === 404, "a callback with no pending record 404s");

  const declined = await handleSlackSetupCallback(get(`${SLACK_SETUP_CALLBACK_PATH}?error=access_denied`, cookie), depsFor(vault));
  ok(declined.status === 400 && (await declined.text()).includes("access_denied"), "a declined install shows Slack's error");
}

{
  const { vault, cookie, state } = await pendingVault();
  const res = await handleSlackSetupCallback(
    get(`${SLACK_SETUP_CALLBACK_PATH}?code=stale&state=${encodeURIComponent(state)}`, cookie),
    depsFor(vault, { exchangeCode: async () => { throw new SlackSetupApiError("oauth.v2.access", "invalid_code"); } }),
  );
  ok(res.status === 400 && (await res.text()).includes("invalid_code"), "a refused exchange shows Slack's code");
  ok((await slackSetupOpen(claimDeps(vault))) === true, "a refused exchange leaves setup open");
  ok(vault.rows.get(SLACK_PENDING_REF) !== undefined, "a refused exchange keeps the pending record so the install can be retried");
}

console.log("  4. credential precedence");
{
  resetSlackCredentialMemo();
  resetSlackCredentialNotices();
  const stored = memoryVault({
    [SLACK_BOT_TOKEN_REF]: "xoxb-from-the-store",
    [SLACK_SIGNING_SECRET_REF]: "signing-from-the-store",
  });

  const both = await resolveSlackSecret("SLACK_BOT_TOKEN", "xoxb-from-the-env", SLACK_BOT_TOKEN_REF, { vault: stored });
  ok(both?.value === "xoxb-from-the-env", "🔴 with BOTH set, the env value wins");
  ok(both?.source === "env", "the reported source is env");

  const storeOnly = await resolveSlackSecret("SLACK_BOT_TOKEN", "", SLACK_BOT_TOKEN_REF, { vault: stored });
  ok(storeOnly?.value === "xoxb-from-the-store" && storeOnly.source === "store", "with only the store set, the stored value is used");

  ok((await resolveSlackSecret("SLACK_BOT_TOKEN", "", SLACK_BOT_TOKEN_REF, { vault: memoryVault() })) === undefined, "with neither set, the answer is undefined");

  const blank = await slackBotToken({ vault: stored, env: { SLACK_BOT_TOKEN: "   " } as NodeJS.ProcessEnv });
  ok(blank === "xoxb-from-the-store", "a blank env var does not shadow the store");

  ok((await resolveSlackSecret("SLACK_BOT_TOKEN", "", SLACK_BOT_TOKEN_REF, { vault: brokenVault() })) === undefined, "an unreachable store reads as nothing stored");

  ok((await slackBotToken({ vault: stored, env: {} as NodeJS.ProcessEnv })) === "xoxb-from-the-store", "slackBotToken reads the store");
  ok((await slackSigningSecret({ vault: stored, env: {} as NodeJS.ProcessEnv })) === "signing-from-the-store", "slackSigningSecret reads the store");
  ok(
    (await slackSigningSecret({ vault: stored, env: { SLACK_SIGNING_SECRET: "signing-from-the-env" } as NodeJS.ProcessEnv })) === "signing-from-the-env",
    "slackSigningSecret prefers the env",
  );
}

{
  resetSlackCredentialMemo();
  resetSlackCredentialNotices();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
  try {
    const stored = memoryVault({ [SLACK_BOT_TOKEN_REF]: "xoxb-from-the-store" });
    const env = { SLACK_BOT_TOKEN: "xoxb-from-the-env" } as NodeJS.ProcessEnv;
    await slackBotToken({ vault: stored, env });
    await slackBotToken({ vault: stored, env });
    console.warn = realWarn;
    ok(warnings.length === 1, "the shadowing notice is logged once, not per call");
    ok(warnings[0]?.includes("SLACK_BOT_TOKEN") === true, "the notice names the env var");
    ok(warnings.every((w) => !w.includes("xoxb-from-the-env") && !w.includes("xoxb-from-the-store")), "🔴 the notice carries no value");

    warnings.length = 0;
    resetSlackCredentialMemo();
    resetSlackCredentialNotices();
    let reads = 0;
    const counting = memoryVault();
    const countingVault = { ...counting, read: async (ref: string) => { reads++; return counting.read(ref); } } as EncryptedKvVault;
    const envOnly = { SLACK_BOT_TOKEN: "xoxb-from-the-env" } as NodeJS.ProcessEnv;
    for (let i = 0; i < 5; i++) {
      ok((await slackBotToken({ vault: countingVault, env: envOnly })) === "xoxb-from-the-env", `resolution ${i + 1} answers from the env`);
    }
    ok(reads === 1, `🔴 five env-wins resolutions cost ONE store read, not five (saw ${reads})`);

    warnings.length = 0;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
    resetSlackCredentialNotices();
    await slackSigningSecret({ vault: memoryVault(), env: { SLACK_SIGNING_SECRET: "x" } as NodeJS.ProcessEnv });
    console.warn = realWarn;
    ok(warnings.length === 0, "env-only is silent — there is nothing being shadowed");
  } finally {
    console.warn = realWarn;
    resetSlackCredentialMemo();
    resetSlackCredentialNotices();
  }
}

{
  const vault = memoryVault();
  const cookie = await mintSetupCookie(claimDeps(vault));

  for (const [name, env] of [
    ["SLACK_BOT_TOKEN", { ...ENV_HOST, SLACK_BOT_TOKEN: "xoxb-already-in-env" }],
    ["SLACK_SIGNING_SECRET", { ...ENV_HOST, SLACK_SIGNING_SECRET: "already-in-env" }],
    ["both", { ...ENV_HOST, SLACK_BOT_TOKEN: "xoxb-already-in-env", SLACK_SIGNING_SECRET: "already-in-env" }],
  ] as const) {
    const d = depsFor(vault, { env });
    ok((await slackSetupOpen({ vault, env: env as NodeJS.ProcessEnv })) === false, `setup is CLOSED when ${name} is set in the environment`);
    ok((await handleSlackSetupGet(get(), d)).status === 404, `GET /setup 404s when ${name} is set`);
    ok((await handleSlackSetupGet(get(SLACK_SETUP_PATH, cookie), d)).status === 404, `…even with a valid claim cookie (${name})`);
    ok((await handleSlackSetupPost(post({ a: "claim", c: "x" }), d)).status === 404, `POST /setup 404s when ${name} is set`);
  }

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await announceSlackSetupCode({ vault, env: { SLACK_BOT_TOKEN: "xoxb-already-in-env" } as NodeJS.ProcessEnv });
    console.log = realLog;
    ok(lines.length === 0, "🔴 the boot notice is SILENT on an env-configured deployment");
    ok(vault.rows.get(SLACK_SETUP_CODE_REF) === undefined, "…and no code is even minted");
  } finally {
    console.log = realLog;
  }

  ok((await handleSlackSetupGet(get(SLACK_SETUP_PATH, cookie), depsFor(vault))).status === 200, "a deployment with no Slack env vars serves the page");
}

{
  resetSlackCredentialMemo();
  resetSlackCredentialNotices();

  let reads = 0;
  const rows = new Map<string, string>([[SLACK_BOT_TOKEN_REF, "xoxb-before-the-reinstall"]]);
  const store = {
    ...memoryVault(),
    read: async (ref: string) => {
      reads++;
      return rows.has(ref) ? (rows.get(ref) as string) : null;
    },
  } as EncryptedKvVault;
  const T0 = 1_000_000;
  const at = (t: number) => ({ vault: store, env: {} as NodeJS.ProcessEnv, memo: true, now: () => t });

  ok((await slackBotToken(at(T0))) === "xoxb-before-the-reinstall", "the first resolution reads the store");
  ok(reads === 1, "…once");

  ok((await slackBotToken(at(T0 + 1_000))) === "xoxb-before-the-reinstall", "within the TTL the value is reused");
  ok(reads === 1, "…with no second store read");

  rows.set(SLACK_BOT_TOKEN_REF, "xoxb-after-the-reinstall");
  ok((await slackBotToken(at(T0 + 1_500))) === "xoxb-before-the-reinstall", "still cached mid-TTL (the memo is real, not a no-op)");

  ok((await slackBotToken(at(T0 + 60_000))) === "xoxb-after-the-reinstall", "🔴 past the TTL the reinstalled credential is picked up");
  ok(reads === 2, "…by exactly one further store read");
  resetSlackCredentialMemo();
  resetSlackCredentialNotices();
}

{
  resetSlackSetupLockCache();
  const rows = new Map<string, string>();
  let reads = 0;
  const live = {
    ...memoryVault(),
    read: async (ref: string) => {
      reads++;
      return rows.has(ref) ? (rows.get(ref) as string) : null;
    },
  } as EncryptedKvVault;

  ok((await slackSetupOpen(claimDeps(live))) === true, "no record ⇒ open");
  const afterFirst = reads;
  ok(afterFirst > 0, "…and that answer came from a store read");

  rows.set(SLACK_INSTALL_REF, INSTALLED);
  ok((await slackSetupOpen(claimDeps(live))) === false, "🔴 a record written between calls is seen WITHOUT a cache reset");
  ok(reads > afterFirst, "…because the injected vault was re-read rather than served from the cache");

  rows.delete(SLACK_INSTALL_REF);
  ok((await slackSetupOpen(claimDeps(live))) === true, "…and removing it reopens, still uncached");
  resetSlackSetupLockCache();
}

{
  resetSlackSetupLockCache();
  const rows2 = new Map<string, string>();
  let reads2 = 0;
  const live2 = {
    ...memoryVault(),
    read: async (ref: string) => {
      reads2++;
      return rows2.has(ref) ? (rows2.get(ref) as string) : null;
    },
  } as EncryptedKvVault;
  const T = 5_000_000;
  const lockAt = (t: number) => ({ vault: live2, env: ENV_HOST, lockCache: true, now: () => t }) as never;

  ok((await slackSetupOpen(lockAt(T))) === true, "the first lock read answers open");
  ok(reads2 === 1, "…from one store read");
  ok((await slackSetupOpen(lockAt(T + 1_000))) === true, "within the TTL the verdict is reused");
  ok(reads2 === 1, "…with no second store read");

  rows2.set(SLACK_INSTALL_REF, INSTALLED);
  ok((await slackSetupOpen(lockAt(T + 2_000))) === true, "a record written mid-TTL is not seen yet");
  ok(reads2 === 1, "…still no extra read");

  ok((await slackSetupOpen(lockAt(T + 10_000))) === false, "🔴 past the TTL the new record is seen");
  ok(reads2 === 2, "…by exactly one further store read");
  resetSlackSetupLockCache();
}

{
  resetSlackClaimSecretCache();
  let reads3 = 0;
  const rows3 = new Map<string, string>([[SLACK_SETUP_CODE_REF, "an-existing-code"]]);
  const live3 = {
    ...memoryVault(),
    read: async (ref: string) => {
      reads3++;
      return rows3.has(ref) ? (rows3.get(ref) as string) : null;
    },
  } as EncryptedKvVault;
  ok((await slackSetupCode(claimDeps(live3))) === "an-existing-code", "an existing code row is read back");
  rows3.set(SLACK_SETUP_CODE_REF, "a-rotated-code");
  ok((await slackSetupCode(claimDeps(live3))) === "a-rotated-code", "🔴 an injected vault is never served stale — a rotated code is seen at once");
  ok(reads3 === 2, "…because each call re-read the store");
  resetSlackClaimSecretCache();
}

console.log("  5. the reserved namespace");
{
  ok(SLACK_APP_REF_NAMESPACE === "slack-app:", "the namespace the barrel publishes is the one these refs use");
  for (const ref of [SLACK_BOT_TOKEN_REF, SLACK_CLIENT_SECRET_REF, SLACK_SIGNING_SECRET_REF, SLACK_COOKIE_KEY_REF, SLACK_SETUP_CODE_REF, SLACK_INSTALL_REF, SLACK_PENDING_REF]) {
    ok(ref.startsWith(SLACK_APP_REF_NAMESPACE), `${ref} is under the reserved namespace`);
  }
  const allRefs = [SLACK_BOT_TOKEN_REF, SLACK_CLIENT_SECRET_REF, SLACK_SIGNING_SECRET_REF, SLACK_COOKIE_KEY_REF, SLACK_SETUP_CODE_REF, SLACK_INSTALL_REF, SLACK_PENDING_REF];
  ok(new Set(allRefs).size === allRefs.length, "no two of the bundle's refs collide");
}

console.log("  6. reopen");
{
  const vault = memoryVault({
    [SLACK_INSTALL_REF]: INSTALLED,
    [SLACK_BOT_TOKEN_REF]: "xoxb-fake-bot-token",
    [SLACK_SIGNING_SECRET_REF]: "fake-signing-secret",
    [SLACK_COOKIE_KEY_REF]: "a-key-from-before-the-reopen",
    [SLACK_PENDING_REF]: '{"v":1,"appId":"A0STALE","clientId":"9.9","state":"stale","startedAt":"2026-10-01T00:00:00.000Z"}',
    [SLACK_PENDING_SIGNING_SECRET_REF]: "a-stale-staged-secret",
  });
  resetSlackSetupLockCache();
  ok((await slackSetupOpen(claimDeps(vault))) === false, "the page starts locked");
  const preReopenCookie = await mintSetupCookie(claimDeps(vault));
  ok(await verifySetupCookie(preReopenCookie, claimDeps(vault)), "precondition: the pre-reopen cookie verifies while its key stands");
  resetSlackClaimSecretCache();
  resetSlackSetupLockCache();
  ok((await reopenSlackSetup(claimDeps(vault))) === true, "reopen reports that a record went");
  resetSlackSetupLockCache();
  ok((await slackSetupOpen(claimDeps(vault))) === true, "the page is open again");

  ok(vault.rows.get(SLACK_BOT_TOKEN_REF) === "xoxb-fake-bot-token", "🔴 reopen keeps the stored bot token");
  ok(vault.rows.get(SLACK_SIGNING_SECRET_REF) === "fake-signing-secret", "🔴 reopen keeps the stored signing secret");

  ok(vault.rows.get(SLACK_COOKIE_KEY_REF) === undefined, "🔴 reopen drops the claim cookie key");
  ok(vault.rows.get(SLACK_PENDING_REF) === undefined, "🔴 reopen drops a stale pending record");
  ok(vault.rows.get(SLACK_PENDING_SIGNING_SECRET_REF) === undefined, "reopen drops a stale staged signing secret");

  ok((await reopenSlackSetup(claimDeps(vault))) === false, "reopening an already-open page reports false");

  resetSlackClaimSecretCache();
  ok(!(await verifySetupCookie(preReopenCookie, claimDeps(vault))), "🔴 a cookie minted before the reopen no longer verifies");
  const withOld = await handleSlackSetupGet(get(SLACK_SETUP_PATH, preReopenCookie), depsFor(vault));
  const withOldBody = await withOld.text();
  ok(withOld.status === 200 && withOldBody.includes("setup code"), "🔴 presenting it lands on the CLAIM screen, not a resumed run");
  ok(!withOldBody.includes("app configuration token"), "…and definitely not the create screen");

  const reopenedBody = await (await handleSlackSetupGet(get(), depsFor(vault))).text();
  ok(reopenedBody.includes("setup code"), "the reopened page asks for the setup code again");
}

{
  const vault = memoryVault({
    [SLACK_SIGNING_SECRET_REF]: "live-signing-secret",
    [SLACK_BOT_TOKEN_REF]: "xoxb-live-bot-token",
  });
  const cookie = await mintSetupCookie(claimDeps(vault));
  await handleSlackSetupPost(
    post({ a: "create", t: "xoxe-fake" }, cookie),
    depsFor(vault, {
      createApp: async () => ({
        appId: "A0SECOND",
        clientId: "3333.4444",
        clientSecret: "second-client-secret",
        signingSecret: "second-signing-secret",
        oauthAuthorizeUrl: "https://slack.com/oauth/v2/authorize",
      }),
    }),
  );
  ok(vault.rows.get(SLACK_PENDING_SIGNING_SECRET_REF) === "second-signing-secret", "the abandoned run staged its new secret");
  ok(vault.rows.get(SLACK_SIGNING_SECRET_REF) === "live-signing-secret", "🔴 the abandoned run left the LIVE signing secret untouched");
  ok(vault.rows.get(SLACK_BOT_TOKEN_REF) === "xoxb-live-bot-token", "🔴 …and the live bot token untouched");
  ok((await slackSigningSecret({ vault, env: {} as NodeJS.ProcessEnv })) === "live-signing-secret", "the resolver still answers the live secret");
}

{
  const vault = memoryVault();
  const first = await slackSetupCode(claimDeps(vault));
  await recordSlackInstall(
    { v: 1, appId: "A1", clientId: "c1", teamId: "T1", installerUserId: "U1", installedAt: "2026-10-02T00:00:00.000Z" },
    { vault },
  );
  await reopenSlackSetup(claimDeps(vault));
  ok(vault.rows.get(SLACK_SETUP_CODE_REF) === undefined, "the reopen drops the old setup code");
  const second = await slackSetupCode(claimDeps(vault));
  ok(second !== first, "🔴 the reopened page mints a DIFFERENT setup code");
  ok(!(await setupCodeMatches(first, claimDeps(vault))), "🔴 the pre-install code no longer matches");
  ok(await setupCodeMatches(second, claimDeps(vault)), "the fresh code matches");
}

{
  const rows = new Map<string, string>([
    [SLACK_INSTALL_REF, INSTALLED],
    [SLACK_SETUP_CODE_REF, "the-pre-install-code"],
    [SLACK_COOKIE_KEY_REF, "the-pre-install-cookie-key"],
  ]);
  const refusesCodeDelete = {
    ...memoryVault(),
    read: async (ref: string) => (rows.has(ref) ? (rows.get(ref) as string) : null),
    write: async (ref: string, v: string) => void rows.set(ref, v),
    delete: async (ref: string) => {
      if (ref === SLACK_SETUP_CODE_REF) throw new Error("store refused the delete");
      return rows.delete(ref);
    },
    withLock: async <T>(_k: string, fn: () => Promise<T>): Promise<T> => fn(),
  } as EncryptedKvVault;

  let threw: unknown;
  await reopenSlackSetup({ vault: refusesCodeDelete }).catch((e: unknown) => void (threw = e));
  ok(threw instanceof Error, "🔴 a reopen that cannot rotate the setup code THROWS");
  ok(rows.get(SLACK_INSTALL_REF) !== undefined, "🔴 …and the install record SURVIVES, so the page stays shut");
  resetSlackSetupLockCache();
  ok((await slackSetupOpen(claimDeps({ ...refusesCodeDelete, delete: async () => false } as EncryptedKvVault))) === false, "…which the lock confirms");
  ok(rows.get(SLACK_SETUP_CODE_REF) === "the-pre-install-code", "the un-rotated code is still there — which is exactly why the page must not open");
  resetSlackSetupLockCache();

  const rows2 = new Map<string, string>([
    [SLACK_INSTALL_REF, INSTALLED],
    [SLACK_SETUP_CODE_REF, "a-code"],
    [SLACK_COOKIE_KEY_REF, "a-key"],
  ]);
  const refusesKeyDelete = {
    ...memoryVault(),
    read: async (ref: string) => (rows2.has(ref) ? (rows2.get(ref) as string) : null),
    write: async (ref: string, v: string) => void rows2.set(ref, v),
    delete: async (ref: string) => {
      if (ref === SLACK_COOKIE_KEY_REF) throw new Error("store refused the delete");
      return rows2.delete(ref);
    },
    withLock: async <T>(_k: string, fn: () => Promise<T>): Promise<T> => fn(),
  } as EncryptedKvVault;
  let threw2: unknown;
  await reopenSlackSetup({ vault: refusesKeyDelete }).catch((e: unknown) => void (threw2 = e));
  ok(threw2 instanceof Error, "🔴 a reopen that cannot rotate the cookie key THROWS");
  ok(rows2.get(SLACK_INSTALL_REF) !== undefined, "🔴 …and the install record SURVIVES");

  const rows3 = new Map<string, string>([
    [SLACK_INSTALL_REF, INSTALLED],
    [SLACK_PENDING_REF, '{"v":1,"appId":"A","clientId":"c","state":"s","startedAt":"2026-10-01T00:00:00.000Z"}'],
  ]);
  const refusesPending = {
    ...memoryVault(),
    read: async (ref: string) => (rows3.has(ref) ? (rows3.get(ref) as string) : null),
    delete: async (ref: string) => {
      if (ref === SLACK_PENDING_REF) throw new Error("store refused the delete");
      return rows3.delete(ref);
    },
    withLock: async <T>(_k: string, fn: () => Promise<T>): Promise<T> => fn(),
  } as EncryptedKvVault;
  ok((await reopenSlackSetup({ vault: refusesPending })) === true, "a refused PENDING delete does not fail the reopen");
  ok(rows3.get(SLACK_INSTALL_REF) === undefined, "…and the record still went");
  resetSlackSetupLockCache();
}

{
  const vault = memoryVault();
  await recordSlackInstall(
    { v: 1, appId: "A1", clientId: "c1", teamId: "T1", installerUserId: "U1", installedAt: "2026-10-02T00:00:00.000Z" },
    { vault },
  );
  ok((await slackInstallState(claimDeps(vault)))?.appId === "A1", "a recorded install reads back");
  await reopenSlackSetup(claimDeps(vault));
  ok((await slackInstallState(claimDeps(vault))) === undefined, "after a reopen there is no install to read");
}

console.log("  7. eve's credential arms");
{
  resetSlackCredentialMemo();
  resetSlackCredentialNotices();
  const stored = memoryVault({ [SLACK_SIGNING_SECRET_REF]: "stored-signing-secret", [SLACK_BOT_TOKEN_REF]: "xoxb-stored" });

  const body = '{"type":"event_callback"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = slackSignature("stored-signing-secret", ts, body);
  const req = new Request("https://oe.example.com/eve/v1/slack", {
    method: "POST",
    headers: { [SLACK_TIMESTAMP_HEADER]: ts, [SLACK_SIGNATURE_HEADER]: signed },
    body,
  });
  const savedBot = process.env.SLACK_BOT_TOKEN;
  const savedSign = process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_SIGNING_SECRET;
  try {
    process.env.SLACK_SIGNING_SECRET = "stored-signing-secret";
    resetSlackCredentialMemo();
    let threw: unknown;
    const accepted = await verifySlackInboundForEve(req, body).catch((e: unknown) => void (threw = e));
    ok(threw === undefined, "eve's verifier ACCEPTS a correctly-signed request through the resolver");
    ok(accepted === true, "🔴 the accept RETURNS true — eve 0.71.0 rejects a request whose verifier returns nothing");

    const badReq = new Request("https://oe.example.com/eve/v1/slack", {
      method: "POST",
      headers: { [SLACK_TIMESTAMP_HEADER]: ts, [SLACK_SIGNATURE_HEADER]: slackSignature("the-wrong-secret", ts, body) },
      body,
    });
    threw = undefined;
    await verifySlackInboundForEve(badReq, body).catch((e: unknown) => void (threw = e));
    ok(threw instanceof Error, "🔴 eve's verifier THROWS on a bad signature (a returned value would be an accept)");

    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const staleReq = new Request("https://oe.example.com/eve/v1/slack", {
      method: "POST",
      headers: { [SLACK_TIMESTAMP_HEADER]: staleTs, [SLACK_SIGNATURE_HEADER]: slackSignature("stored-signing-secret", staleTs, body) },
      body,
    });
    threw = undefined;
    await verifySlackInboundForEve(staleReq, body).catch((e: unknown) => void (threw = e));
    ok(threw instanceof Error, "a replayed (stale-timestamp) request is refused");

    threw = undefined;
    await verifySlackInboundForEve(new Request("https://oe.example.com/eve/v1/slack", { method: "POST", body }), body).catch((e: unknown) => void (threw = e));
    ok(threw instanceof Error, "a request with no signature headers is refused");

    delete process.env.SLACK_SIGNING_SECRET;
    resetSlackCredentialMemo();
    threw = undefined;
    await verifySlackInboundForEve(req, body).catch((e: unknown) => void (threw = e));
    ok(threw instanceof Error, "🔴 with no signing secret at all, eve's verifier REFUSES (never passes)");

    threw = undefined;
    await slackBotTokenForEve().catch((e: unknown) => void (threw = e));
    ok(threw instanceof Error && (threw as Error).message === "SLACK_BOT_TOKEN is required.", "the bot-token arm throws eve's exact message");

    process.env.SLACK_BOT_TOKEN = "xoxb-resolved";
    resetSlackCredentialMemo();
    ok((await slackBotTokenForEve()) === "xoxb-resolved", "the bot-token arm resolves through the seam");
  } finally {
    if (savedBot === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedBot;
    if (savedSign === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = savedSign;
    resetSlackCredentialMemo();
    resetSlackCredentialNotices();
  }
  void stored;
}

console.log("  8. the login-wall probe");
{
  async function screen2(answer: () => Promise<Response>): Promise<{ status: number; body: string; calls: { url: string; init: RequestInit }[] }> {
    const vault = memoryVault();
    const cookie = await mintSetupCookie(claimDeps(vault));
    const calls: { url: string; init: RequestInit }[] = [];
    const probeFetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return answer();
    };
    const res = await handleSlackSetupGet(get(SLACK_SETUP_PATH, cookie), depsFor(vault, { probeFetch }));
    return { status: res.status, body: await res.text(), calls };
  }

  const walled = await screen2(async () => new Response("login required", { status: 401 }));
  ok(walled.status === 200 && walled.body.includes("app configuration token"), "a walled host still renders screen 2");
  ok(walled.body.includes("Slack cannot reach <code>oe.example.com</code>"), "🔴 a 401 from the base URL renders the warning, naming the host");
  ok(walled.body.includes("OE_PUBLIC_BASE_URL"), "🔴 the warning names OE_PUBLIC_BASE_URL, the variable that fixes it");
  ok(walled.body.includes("<code>401</code>"), "the warning names the status the host answered");

  ok(walled.calls.length === 1 && walled.calls[0]!.url === `${ENV_HOST.OE_PUBLIC_BASE_URL}${SLACK_SETUP_PATH}`, "the probe asks <base>/setup once");
  ok(walled.calls[0]!.init.redirect === "manual", "the probe does not follow a redirect (Slack does not)");
  ok(walled.calls[0]!.init.headers === undefined, "the probe carries no header, so no cookie reaches the host");

  for (const status of [403, 302, 307]) {
    const r = await screen2(async () => new Response(null, { status, headers: status < 400 ? { location: "https://login.example.com/" } : {} }));
    ok(r.body.includes("Slack cannot reach") && r.body.includes(`<code>${status}</code>`), `a ${status} from the base URL renders the warning`);
  }

  const open = await screen2(publicHost);
  ok(!open.body.includes("Slack cannot reach"), "a 200 from the base URL renders no warning");
  ok(open.body.includes("every request URL in the app's manifest names that host"), "screen 2 names the host the manifest points at");
  const notFound = await screen2(async () => new Response(null, { status: 404 }));
  ok(!notFound.body.includes("Slack cannot reach"), "a 404 is not a login wall: no warning");
  const unreachable = await screen2(async () => {
    throw new TypeError("fetch failed");
  });
  ok(unreachable.status === 200 && !unreachable.body.includes("Slack cannot reach"), "a probe that cannot connect renders screen 2 with no warning");

  const vault = memoryVault();
  const cookie = await mintSetupCookie(claimDeps(vault));
  const reRender = await handleSlackSetupPost(
    post({ a: "create", t: "  " }, cookie),
    depsFor(vault, { probeFetch: async () => new Response(null, { status: 401 }) }),
  );
  ok((await reRender.text()).includes("Slack cannot reach"), "the POST re-render of screen 2 carries the warning too");
}

console.log(`✓ slack setup: ${n} assertions`);
