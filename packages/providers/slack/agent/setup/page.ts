import {
  BUTTON_STYLE,
  CODE_BLOCK_STYLE,
  agentDisplayName,
  appendAudit,
  credentialKeyArmed,
  deploymentOrg,
  encryptedKvVault,
  escapeHtml,
  pageBaseUrl,
  securePageResponse,
  SLACK_APP_REF_NAMESPACE,
  type EncryptedKvVault,
} from "@open-everywhere/core/agent/adapter-api.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SLACK_DEPLOY_HOST_PLACEHOLDER, slackAppManifestTemplate, slackAppNameProblem, slackManifestAppName } from "../app-manifest.js";
import { slackManifestOptionsFromSettings } from "../ops.js";
import {
  SETUP_COOKIE_NAME,
  mintSetupCookie,
  setupCodeMatches,
  setupCookieFrom,
  setupCookieHeader,
  slackSetupOpen,
  verifySetupCookie,
  type SlackClaimDeps,
} from "./claim.js";
import {
  SLACK_BOT_TOKEN_REF,
  SLACK_CLIENT_SECRET_REF,
  SLACK_COOKIE_KEY_REF,
  SLACK_PENDING_REF,
  SLACK_PENDING_SIGNING_SECRET_REF,
  SLACK_SETUP_CODE_REF,
  SLACK_SIGNING_SECRET_REF,
  recordSlackInstall,
  type SlackInstallState,
} from "./install-state.js";
import { createSlackApp, exchangeSlackOauthCode, SlackSetupApiError } from "./slack-api-setup.js";

export const SLACK_SETUP_PATH = "/setup";
export const SLACK_SETUP_CALLBACK_PATH = "/setup/callback";

const FIELD_CODE = "c";
const FIELD_CONFIG_TOKEN = "t";
const FIELD_APP_NAME = "n";
const FIELD_ACTION = "a";

const SLACK_SETUP_INSTALLED = "surface.app_installed";

interface PendingSlackApp {
  readonly v: 1;
  readonly appId: string;
  readonly clientId: string;
  readonly state: string;
  readonly startedAt: string;
}

export interface SlackSetupPageDeps extends SlackClaimDeps {
  readonly vault?: EncryptedKvVault;
  readonly env?: NodeJS.ProcessEnv;
  readonly createApp?: typeof createSlackApp;
  readonly exchangeCode?: typeof exchangeSlackOauthCode;
  readonly keyArmed?: () => boolean;
  readonly probeFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

function vaultOf(deps: SlackSetupPageDeps): EncryptedKvVault {
  return deps.vault ?? encryptedKvVault();
}

function notAvailable(): Response {
  return securePageResponse(
    404,
    "Not available",
    `<p>This page is not available on this deployment.</p>` +
      `<p>If Slack is already installed here, setup is closed. An administrator can reopen it with the ` +
      `<code>reopen_slack_setup</code> control call.</p>`,
  );
}

function slackRefused(code: string): Response {
  return securePageResponse(
    400,
    "Slack refused the request",
    `<p>Slack answered: <code>${escapeHtml(code)}</code></p>` +
      `<p>The most common cause is an app configuration token that has expired — they last about 12 hours. ` +
      `Get a fresh one at <code>api.slack.com/apps</code> → "Your App Configuration Tokens", then start again.</p>` +
      `<p><a href="${escapeHtml(SLACK_SETUP_PATH)}">Back to setup</a></p>`,
  );
}

function baseUrl(deps: SlackSetupPageDeps): string | undefined {
  return pageBaseUrl(deps.env ?? process.env);
}

function manifestForHost(host: string, appName: string | undefined): string {
  const template = slackAppManifestTemplate(slackManifestOptionsFromSettings(appName ? { appName } : {}));
  return template.split(SLACK_DEPLOY_HOST_PLACEHOLDER).join(host);
}

function manifestHost(base: string): string {
  return base.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

const PROBE_TIMEOUT_MS = 3_000;

async function loginWallStatus(base: string, deps: SlackSetupPageDeps): Promise<number | undefined> {
  let res: Response;
  try {
    res = await (deps.probeFetch ?? fetch)(`${base}${SLACK_SETUP_PATH}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  await res.body?.cancel().catch(() => undefined);
  const s = res.status;
  return s === 401 || s === 403 || (s >= 300 && s < 400) ? s : undefined;
}

function loginWallWarning(host: string, status: number): string {
  return (
    `<p style="color:#b91c1c"><strong>Slack cannot reach <code>${escapeHtml(host)}</code>.</strong> This deployment ` +
    `asked its own <code>${escapeHtml(SLACK_SETUP_PATH)}</code> at that host with no login, and the host answered ` +
    `<code>${status}</code>. That is the answer of a login wall, such as Vercel deployment protection, or of a redirect. ` +
    `Slack sends its requests with no login and follows no redirect, so an app created here would never receive an event.</p>` +
    `<p>Set <code>OE_PUBLIC_BASE_URL</code> to a public host of this deployment (for example its custom domain) and ` +
    `redeploy, or remove the protection from this host. Then reload this page.</p>`
  );
}

async function createScreenFor(base: string, deps: SlackSetupPageDeps): Promise<Response> {
  const host = manifestHost(base);
  const wall = await loginWallStatus(base, deps);
  return createScreen(host, wall === undefined ? "" : loginWallWarning(host, wall));
}

function claimScreen(retry: boolean): Response {
  return securePageResponse(
    200,
    `Set up ${agentDisplayName()}`,
    (retry ? `<p style="color:#b91c1c">That code did not match. Check the deployment's logs and try again.</p>` : "") +
      `<p>This deployment logged a one-time setup code when it started. Find it in the deployment's logs ` +
      `(<code>vercel logs</code>, <code>docker logs</code>) and paste it here.</p>` +
      `<form method="post" action="${escapeHtml(SLACK_SETUP_PATH)}">` +
      `<input type="hidden" name="${FIELD_ACTION}" value="claim">` +
      `<p><input name="${FIELD_CODE}" type="password" autocomplete="off" required style="width:100%;padding:.5rem;font:inherit" ` +
      `placeholder="setup code"></p>` +
      `<button type="submit" style="${BUTTON_STYLE}">Continue</button>` +
      `</form>`,
  );
}

function createScreen(host: string, warning: string): Response {
  return securePageResponse(
    200,
    "Create the Slack app",
    warning +
      `<p>Open <code>api.slack.com/apps</code>, scroll to <strong>Your App Configuration Tokens</strong>, ` +
      `and generate one for the workspace that will host the agent. Paste it below. It needs the ` +
      `<code>app_configurations:write</code> scope and lasts about 12 hours.</p>` +
      `<p>This page will create the Slack app for <code>${escapeHtml(host)}</code>: every request URL in the ` +
      `app's manifest names that host, so Slack must be able to reach it with no login. It keeps the app's ` +
      `credentials in this deployment's own encrypted store. The configuration token is used once and never stored.</p>` +
      `<form method="post" action="${escapeHtml(SLACK_SETUP_PATH)}">` +
      `<input type="hidden" name="${FIELD_ACTION}" value="create">` +
      `<p><input name="${FIELD_CONFIG_TOKEN}" type="password" autocomplete="off" required style="width:100%;padding:.5rem;font:inherit" ` +
      `placeholder="xoxe.xoxp-… (app configuration token)"></p>` +
      `<p><label>App name (optional)<br><input name="${FIELD_APP_NAME}" type="text" autocomplete="off" ` +
      `style="width:100%;padding:.5rem;font:inherit" placeholder="${escapeHtml(slackManifestAppName(slackManifestOptionsFromSettings()))}"></label></p>` +
      `<button type="submit" style="${BUTTON_STYLE}">Create the Slack app</button>` +
      `</form>`,
  );
}

function installScreen(authorizeUrl: string): Response {
  return securePageResponse(
    200,
    "Install to your workspace",
    `<p>The Slack app exists. Installing it is the step that gives ${escapeHtml(agentDisplayName())} a bot token for ` +
      `your workspace, and it has to be done by someone who can approve an app there.</p>` +
      `<p><a href="${escapeHtml(authorizeUrl)}" style="${BUTTON_STYLE};display:inline-block;text-decoration:none">` +
      `Install to Slack</a></p>` +
      `<p>Slack will list the permissions and bring you back here.</p>`,
  );
}

function doneScreen(state: SlackInstallState): Response {
  const surfaceLine = `  defineSurface({ key: "slack/${state.teamId}", trust: "internal" }),`;
  const adminLine = `  admins: ["slack/${state.teamId}/${state.installerUserId}"],`;
  return securePageResponse(
    200,
    "Slack is installed",
    `<p>${escapeHtml(agentDisplayName())} is installed in <strong>${escapeHtml(state.teamName ?? state.teamId)}</strong>. ` +
      `Its credentials are in this deployment's encrypted store; nothing else needs setting.</p>` +
      `<p>Two config edits are left. They are not secrets — they say which workspace this deployment ` +
      `trusts, and who administers it — so they belong in your git repo and deploy with it.</p>` +
      `<p><strong>1.</strong> In <code>agent/identity/surfaces.ts</code>, inside the surfaces array:</p>` +
      `<pre style="${CODE_BLOCK_STYLE}">${escapeHtml(surfaceLine)}</pre>` +
      `<p><strong>2.</strong> In <code>agent/memory/config/domains/org.ts</code>, replace the <code>admins</code> line:</p>` +
      `<pre style="${CODE_BLOCK_STYLE}">${escapeHtml(adminLine)}</pre>` +
      `<p><strong>Then make the two edits by hand and push.</strong> The deploy that lands them is the ` +
      `last step. The bot does not change its own admins from chat. To see what it can change from ` +
      `chat, ask it.</p>` +
      `<p>This page is now closed. An administrator can reopen it with the <code>reopen_slack_setup</code> ` +
      `control call.</p>`,
  );
}

async function readPending(deps: SlackSetupPageDeps): Promise<PendingSlackApp | undefined> {
  let raw: string | null;
  try {
    raw = await vaultOf(deps).read(SLACK_PENDING_REF);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  const str = (k: string): string | undefined => (typeof r[k] === "string" && (r[k] as string).length > 0 ? (r[k] as string) : undefined);
  const appId = str("appId");
  const clientId = str("clientId");
  const state = str("state");
  const startedAt = str("startedAt");
  if (!appId || !clientId || !state || !startedAt) return undefined;
  return { v: 1, appId, clientId, state, startedAt };
}

function authorizeUrlFor(pending: PendingSlackApp, base: string, scopes: string): string {
  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", pending.clientId);
  u.searchParams.set("scope", scopes);
  u.searchParams.set("redirect_uri", `${base}${SLACK_SETUP_CALLBACK_PATH}`);
  u.searchParams.set("state", pending.state);
  return u.toString();
}

function manifestBotScopes(): string {
  const parsed = JSON.parse(slackAppManifestTemplate(slackManifestOptionsFromSettings())) as {
    oauth_config?: { scopes?: { bot?: readonly string[] } };
  };
  const bot = parsed.oauth_config?.scopes?.bot ?? [];
  return bot.join(",");
}

export async function handleSlackSetupGet(req: Request, deps: SlackSetupPageDeps = {}): Promise<Response> {
  if (!(deps.keyArmed ?? credentialKeyArmed)()) return notAvailable();
  if (!(await slackSetupOpen(deps))) return notAvailable();

  if (!(await verifySetupCookie(setupCookieFrom(req), deps))) return claimScreen(false);

  const base = baseUrl(deps);
  if (base === undefined) {
    return securePageResponse(
      500,
      "This deployment does not know its own URL",
      `<p>This deployment could not work out the public URL to put in the Slack app, so it will not ` +
        `create one that points at the wrong place.</p>` +
        `<p>Set <code>OE_PUBLIC_BASE_URL</code> to this deployment's public URL and redeploy.</p>`,
    );
  }

  const pending = await readPending(deps);
  if (pending) return installScreen(authorizeUrlFor(pending, base, manifestBotScopes()));
  return createScreenFor(base, deps);
}

export async function handleSlackSetupPost(req: Request, deps: SlackSetupPageDeps = {}): Promise<Response> {
  if (!(deps.keyArmed ?? credentialKeyArmed)()) return notAvailable();
  if (!(await slackSetupOpen(deps))) return notAvailable();

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return notAvailable();
  }
  const action = form.get(FIELD_ACTION) ?? "";

  if (action === "claim") {
    const presented = form.get(FIELD_CODE) ?? "";
    if (presented.trim().length === 0) return claimScreen(false);
    if (!(await setupCodeMatches(presented, deps))) return claimScreen(true);
    const cookie = await mintSetupCookie(deps);
    return new Response(null, {
      status: 303,
      headers: { location: SLACK_SETUP_PATH, "set-cookie": setupCookieHeader(cookie), "cache-control": "no-store" },
    });
  }

  if (!(await verifySetupCookie(setupCookieFrom(req), deps))) return notAvailable();

  if (action !== "create") return notAvailable();

  const base = baseUrl(deps);
  if (base === undefined) return notAvailable();

  const configToken = (form.get(FIELD_CONFIG_TOKEN) ?? "").trim();
  if (configToken.length === 0) return createScreenFor(base, deps);

  const rawName = (form.get(FIELD_APP_NAME) ?? "").trim();
  if (rawName.length > 0) {
    const problem = slackAppNameProblem(rawName);
    if (problem) return slackRefused(`app_name: ${problem}`);
  }

  let created;
  try {
    created = await (deps.createApp ?? createSlackApp)(
      { configToken, manifest: manifestForHost(manifestHost(base), rawName.length > 0 ? rawName : undefined) },
      {},
    );
  } catch (err) {
    return slackRefused(err instanceof SlackSetupApiError ? err.code : "request_failed");
  }

  const vault = vaultOf(deps);
  try {
    await vault.write(SLACK_CLIENT_SECRET_REF, created.clientSecret, { connector: "slack", createdBy: "host:slack-setup" });
    await vault.write(SLACK_PENDING_SIGNING_SECRET_REF, created.signingSecret, { connector: "slack", createdBy: "host:slack-setup" });
    const pending: PendingSlackApp = {
      v: 1,
      appId: created.appId,
      clientId: created.clientId,
      state: randomBytes(16).toString("base64url"),
      startedAt: new Date().toISOString(),
    };
    await vault.write(SLACK_PENDING_REF, JSON.stringify(pending), { connector: "slack", createdBy: "host:slack-setup" });
  } catch {
    return securePageResponse(
      500,
      "Could not store the Slack credentials",
      `<p>The Slack app was created, but this deployment could not write its credentials to the ` +
        `encrypted store. Check that <code>OE_CREDENTIAL_ENCRYPTION_KEY</code> is set and that the ` +
        `database is reachable, then start again — you will need a fresh app configuration token.</p>`,
    );
  }

  return new Response(null, { status: 303, headers: { location: SLACK_SETUP_PATH, "cache-control": "no-store" } });
}

export async function handleSlackSetupCallback(req: Request, deps: SlackSetupPageDeps = {}): Promise<Response> {
  if (!(deps.keyArmed ?? credentialKeyArmed)()) return notAvailable();
  if (!(await slackSetupOpen(deps))) return notAvailable();
  if (!(await verifySetupCookie(setupCookieFrom(req), deps))) return notAvailable();

  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const presentedState = url.searchParams.get("state") ?? "";
  if (code.length === 0) {
    return slackRefused(url.searchParams.get("error") ?? "no_code");
  }

  const pending = await readPending(deps);
  if (!pending) return notAvailable();

  const a = Buffer.from(presentedState);
  const b = Buffer.from(pending.state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return notAvailable();

  const base = baseUrl(deps);
  if (base === undefined) return notAvailable();

  const vault = vaultOf(deps);
  let clientSecret: string | null;
  try {
    clientSecret = await vault.read(SLACK_CLIENT_SECRET_REF);
  } catch {
    return notAvailable();
  }
  if (clientSecret === null) return notAvailable();

  let install;
  try {
    install = await (deps.exchangeCode ?? exchangeSlackOauthCode)(
      {
        clientId: pending.clientId,
        clientSecret,
        code,
        redirectUri: `${base}${SLACK_SETUP_CALLBACK_PATH}`,
      },
      {},
    );
  } catch (err) {
    return slackRefused(err instanceof SlackSetupApiError ? err.code : "request_failed");
  }

  const state: SlackInstallState = {
    v: 1,
    appId: pending.appId,
    clientId: pending.clientId,
    teamId: install.teamId,
    installerUserId: install.installerUserId,
    installedAt: new Date().toISOString(),
    ...(install.teamName ? { teamName: install.teamName } : {}),
  };

  try {
    const staged = await vault.read(SLACK_PENDING_SIGNING_SECRET_REF);
    if (staged === null) return notAvailable();
    await vault.write(SLACK_SIGNING_SECRET_REF, staged, { connector: "slack", createdBy: "host:slack-setup" });
    await vault.write(SLACK_BOT_TOKEN_REF, install.botToken, { connector: "slack", createdBy: "host:slack-setup" });
    await vault.delete(SLACK_SETUP_CODE_REF).catch(() => undefined);
    await vault.delete(SLACK_COOKIE_KEY_REF).catch(() => undefined);
    await recordSlackInstall(state, deps);
  } catch {
    return securePageResponse(
      500,
      "Could not store the Slack install",
      `<p>Slack authorized the install, but this deployment could not write it to the encrypted store. ` +
        `Check that <code>OE_CREDENTIAL_ENCRYPTION_KEY</code> is set and the database is reachable.</p>` +
        `<p><strong>Then restart or redeploy this deployment before trying again.</strong> This run has ` +
        `already used up its one-time setup code and its claim cookie, and a fresh code is logged only ` +
        `when the deployment starts. Without a restart, <code>/setup</code> will refuse every code you have.</p>` +
        `<p>The Slack app itself was created and installed — you do not need a new app configuration ` +
        `token for the retry, but you will need to install again.</p>`,
    );
  }

  await vault.delete(SLACK_PENDING_REF).catch(() => undefined);
  await vault.delete(SLACK_PENDING_SIGNING_SECRET_REF).catch(() => undefined);

  await appendAudit({
    org: deploymentOrg(),
    platform: "slack",
    workspace: state.teamId,
    action: SLACK_SETUP_INSTALLED,
    detail: { appId: state.appId, teamId: state.teamId, installerUserId: state.installerUserId },
  }).catch(() => undefined);

  const res = doneScreen(state);
  res.headers.append("set-cookie", `${SETUP_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return res;
}
