import { callSlackWebApi } from "../channels/slack-web-api.js";

export class SlackSetupApiError extends Error {
  readonly code: string;
  constructor(operation: string, code: string) {
    super(`Slack refused ${operation}: ${code}`);
    this.name = "SlackSetupApiError";
    this.code = code;
  }
}

export interface CreatedSlackApp {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
  readonly oauthAuthorizeUrl: string;
}

export interface SlackSetupApiDeps {
  readonly call?: typeof callSlackWebApi;
}

function requireString(operation: string, res: Record<string, unknown>, key: string): string {
  const v = res[key];
  if (typeof v !== "string" || v.length === 0) throw new SlackSetupApiError(operation, `missing_field:${key}`);
  return v;
}

function slackErrorCode(res: Record<string, unknown>): string {
  const e = res.error;
  return typeof e === "string" && e.length > 0 ? e : "unknown_error";
}

export async function createSlackApp(
  input: { readonly configToken: string; readonly manifest: string },
  deps: SlackSetupApiDeps = {},
): Promise<CreatedSlackApp> {
  const call = deps.call ?? callSlackWebApi;
  let res: Record<string, unknown>;
  try {
    res = (await call({
      botToken: input.configToken,
      operation: "apps.manifest.create",
      body: { manifest: input.manifest },
    })) as Record<string, unknown>;
  } catch {
    throw new SlackSetupApiError("apps.manifest.create", "request_failed");
  }
  if (res.ok !== true) throw new SlackSetupApiError("apps.manifest.create", slackErrorCode(res));

  const credentials = res.credentials;
  if (typeof credentials !== "object" || credentials === null) {
    throw new SlackSetupApiError("apps.manifest.create", "missing_field:credentials");
  }
  const c = credentials as Record<string, unknown>;
  return {
    appId: requireString("apps.manifest.create", res, "app_id"),
    clientId: requireString("apps.manifest.create", c, "client_id"),
    clientSecret: requireString("apps.manifest.create", c, "client_secret"),
    signingSecret: requireString("apps.manifest.create", c, "signing_secret"),
    oauthAuthorizeUrl: requireString("apps.manifest.create", res, "oauth_authorize_url"),
  };
}

export interface SlackOauthInstall {
  readonly botToken: string;
  readonly teamId: string;
  readonly teamName?: string;
  readonly installerUserId: string;
}

export async function exchangeSlackOauthCode(
  input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  },
  deps: SlackSetupApiDeps = {},
): Promise<SlackOauthInstall> {
  const call = deps.call ?? callSlackWebApi;
  let res: Record<string, unknown>;
  try {
    res = (await call({
      unauthenticated: true,
      operation: "oauth.v2.access",
      body: {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      },
    })) as Record<string, unknown>;
  } catch {
    throw new SlackSetupApiError("oauth.v2.access", "request_failed");
  }
  if (res.ok !== true) throw new SlackSetupApiError("oauth.v2.access", slackErrorCode(res));

  const team = res.team;
  const authedUser = res.authed_user;
  if (typeof team !== "object" || team === null) throw new SlackSetupApiError("oauth.v2.access", "missing_field:team");
  if (typeof authedUser !== "object" || authedUser === null) {
    throw new SlackSetupApiError("oauth.v2.access", "missing_field:authed_user");
  }
  const t = team as Record<string, unknown>;
  const u = authedUser as Record<string, unknown>;
  const teamName = typeof t.name === "string" && t.name.length > 0 ? t.name : undefined;
  return {
    botToken: requireString("oauth.v2.access", res, "access_token"),
    teamId: requireString("oauth.v2.access", t, "id"),
    installerUserId: requireString("oauth.v2.access", u, "id"),
    ...(teamName ? { teamName } : {}),
  };
}
