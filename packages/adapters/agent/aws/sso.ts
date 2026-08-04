import {
  warmCredential,
  encryptedKvVault,
  requireAwsSsoLinkStore,
  OE_AWS_SSO_CALLBACK_PATH,
  type AwsCredentials,
  type AwsIdentityRequest,
  type AwsSsoLinkStore,
  type EncryptedKvVault,
} from "@open-everywhere/core/agent/adapter-api.js";
import { makePkce, makeState } from "../oe-oauth/pkce.js";

export type FetchLike = typeof fetch;

export { OE_AWS_SSO_CALLBACK_PATH };

const DEFAULT_SSO_SCOPES = ["sso:account:access"] as const;
const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;
const DEFAULT_EXPIRY_SKEW_MS = 60 * 1000;
const DEFAULT_CRED_TTL_SECONDS = 3600;

interface AwsSsoTokenRecord {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly region: string;
  readonly obtainedAtMs: number;
}

interface AwsSsoPendingRecord {
  readonly principalId: string;
  readonly verifier: string;
  readonly region: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumed?: boolean;
}

export class AwsSsoLinkRequiredError extends Error {
  readonly code = "aws_sso_link_required";
  readonly authorizationUrl: string;
  constructor(authorizationUrl: string, why: string) {
    super(
      `your AWS account isn't linked yet — ${why}. Open this personal link to connect it (expires soon): ` +
        `${authorizationUrl} — complete the AWS sign-in, then ask again. This acts as YOU with YOUR own ` +
        `Identity Center access, bounded by the role granted to this channel. If you later say you've ` +
        `signed in, RETRY the operation to re-check.`,
    );
    this.name = "AwsSsoLinkRequiredError";
    this.authorizationUrl = authorizationUrl;
  }
}

export function isAwsSsoLinkRequired(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return code === "aws_sso_link_required" || e.name === "AwsSsoLinkRequiredError";
}

export function makeAwsSsoLinkStore(vault: EncryptedKvVault = encryptedKvVault()): AwsSsoLinkStore {
  const tokRef = (principalId: string) => `aws-sso:tok:${principalId}`;
  return {
    async read(principalId: string): Promise<string | null> {
      return vault.read(tokRef(principalId));
    },
    async write(principalId: string, token: string): Promise<void> {
      await vault.write(tokRef(principalId), token, { provider: "aws-sso" });
    },
    async clear(principalId: string): Promise<void> {
      await vault.write(tokRef(principalId), "", { provider: "aws-sso" });
    },
  };
}

export interface AwsSsoPendingStore {
  read(state: string): Promise<string | null>;
  write(state: string, value: string): Promise<void>;
}

export interface AwsSsoMinterOptions {
  readonly region?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly fetch?: FetchLike;
  readonly store?: AwsSsoLinkStore;
  readonly pending?: AwsSsoPendingStore;
  readonly redirectUri?: () => string | undefined;
  readonly now?: () => number;
  readonly newPkce?: () => { readonly verifier: string; readonly challenge: string };
  readonly newState?: () => string;
  readonly pendingTtlMs?: number;
  readonly expirySkewMs?: number;
}

export interface AwsSsoMinter {
  mint(req: AwsIdentityRequest): Promise<AwsCredentials>;
  startLink(principalId: string): Promise<{ url: string }>;
  completeLink(state: string, code: string): Promise<{ principalId: string }>;
}

function defaultRedirectUri(): string | undefined {
  const base = process.env.OE_PUBLIC_BASE_URL?.trim().replace(/\/+$/u, "");
  if (!base) return undefined;
  const withScheme = /^https?:\/\//iu.test(base) ? base : `https://${base}`;
  return `${withScheme}${OE_AWS_SSO_CALLBACK_PATH}`;
}

function defaultPendingStore(vault: EncryptedKvVault): AwsSsoPendingStore {
  const pendRef = (state: string) => `aws-sso:pend:${state}`;
  return {
    read: (state) => vault.read(pendRef(state)),
    write: async (state, value) => {
      await vault.write(pendRef(state), value, { provider: "aws-sso" });
    },
  };
}

export function parseRoleArn(roleArn: string): { accountId: string; roleName: string } {
  const m = /^arn:aws[\w-]*:iam::(\d{12}):role\/(.+)$/u.exec(roleArn);
  if (!m) {
    throw new Error(
      `AWS SSO mint: granted roleArn "${roleArn}" is not an IAM role ARN (expected ` +
        `arn:aws:iam::<account>:role/<name>). Fail-closed: no AWS access.`,
    );
  }
  return { accountId: m[1]!, roleName: m[2]! };
}

export function makeAwsSsoMinter(opts: AwsSsoMinterOptions = {}): AwsSsoMinter {
  const fetchImpl = opts.fetch ?? fetch;
  const region = opts.region;
  const clientId = opts.clientId;
  const scopes = opts.scopes ?? DEFAULT_SSO_SCOPES;
  const vault = encryptedKvVault();
  const pendingStore = opts.pending ?? defaultPendingStore(vault);
  const store = () => opts.store ?? requireAwsSsoLinkStore();
  const redirectUriOf = opts.redirectUri ?? defaultRedirectUri;
  const now = opts.now ?? Date.now;
  const newPkce = opts.newPkce ?? makePkce;
  const newState = opts.newState ?? makeState;
  const pendingTtl = opts.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const skew = opts.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;

  function requireRegion(): string {
    if (!region) {
      throw new Error(
        "AWS SSO is not configured — no Identity Center region (set OE_AWS_SSO_REGION or OE_AWS_REGION). " +
          "Fail-closed: no per-user AWS access.",
      );
    }
    return region;
  }
  function requireClientId(): string {
    if (!clientId) {
      throw new Error(
        "AWS SSO link is not configured — no OIDC client id (set OE_AWS_SSO_CLIENT_ID). Register a public " +
          "PKCE client in Identity Center. Fail-closed: no per-user AWS link.",
      );
    }
    return clientId;
  }
  const authorizeEndpoint = () => `https://oidc.${requireRegion()}.amazonaws.com/authorize`;
  const tokenEndpoint = () => `https://oidc.${requireRegion()}.amazonaws.com/token`;
  const portalEndpoint = () => `https://portal.sso.${requireRegion()}.amazonaws.com/federation/credentials`;

  async function startLink(principalId: string): Promise<{ url: string }> {
    const reg = requireRegion();
    const cid = requireClientId();
    const redirectUri = redirectUriOf();
    if (!redirectUri) {
      throw new Error(
        "AWS SSO link: OE_PUBLIC_BASE_URL is unset — cannot build a redirect_uri for the Identity Center " +
          "callback. Fail-closed.",
      );
    }
    const pkce = newPkce();
    const state = newState();
    const pending: AwsSsoPendingRecord = {
      principalId,
      verifier: pkce.verifier,
      region: reg,
      createdAt: now(),
      expiresAt: now() + pendingTtl,
    };
    await pendingStore.write(state, JSON.stringify(pending));
    const u = new URL(authorizeEndpoint());
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cid);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", pkce.challenge);
    u.searchParams.set("code_challenge_method", "S256");
    if (scopes.length) u.searchParams.set("scope", scopes.join(" "));
    return { url: u.toString() };
  }

  async function completeLink(state: string, code: string): Promise<{ principalId: string }> {
    const cid = requireClientId();
    const redirectUri = redirectUriOf();
    if (!redirectUri) throw new Error("AWS SSO link: OE_PUBLIC_BASE_URL is unset — cannot complete without a redirect_uri.");
    const raw = await pendingStore.read(state);
    if (!raw) throw new Error("AWS SSO link: unknown or expired authorization state.");
    const pending = JSON.parse(raw) as AwsSsoPendingRecord;
    if (pending.consumed) throw new Error("AWS SSO link: authorization state already used.");
    if (now() > pending.expiresAt) throw new Error("AWS SSO link: authorization state expired.");
    const tok = await exchangeToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: cid,
      code_verifier: pending.verifier,
    });
    const record: AwsSsoTokenRecord = {
      accessToken: tok.access_token,
      ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}),
      ...(typeof tok.expires_in === "number" ? { expiresAtMs: now() + tok.expires_in * 1000 } : {}),
      region: pending.region,
      obtainedAtMs: now(),
    };
    await store().write(pending.principalId, JSON.stringify(record));
    await pendingStore.write(state, JSON.stringify({ ...pending, consumed: true, verifier: "" }));
    return { principalId: pending.principalId };
  }

  interface OidcTokenResponse {
    readonly access_token: string;
    readonly refresh_token?: string;
    readonly expires_in?: number;
    readonly token_type?: string;
  }

  async function exchangeToken(form: Record<string, string>): Promise<OidcTokenResponse> {
    const endpoint = tokenEndpoint();
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      });
    } catch (err) {
      throw new Error(
        `AWS SSO OIDC token transport error against ${endpoint}: ${err instanceof Error ? err.message : String(err)}. Fail-closed.`,
      );
    }
    if (!res.ok) {
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body?.error === "string") code = body.error;
      } catch {
      }
      throw new Error(`AWS SSO OIDC token endpoint returned ${res.status}${code ? ` (${code})` : ""}. Fail-closed.`);
    }
    const body = (await res.json().catch(() => ({}))) as OidcTokenResponse;
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new Error(`AWS SSO OIDC token endpoint returned no access_token. Fail-closed.`);
    }
    return body;
  }

  async function freshAccessToken(principalId: string): Promise<string> {
    const raw = await store().read(principalId);
    if (!raw) {
      const { url } = await startLink(principalId);
      throw new AwsSsoLinkRequiredError(url, "no linked AWS Identity Center identity");
    }
    let rec: AwsSsoTokenRecord;
    try {
      rec = JSON.parse(raw) as AwsSsoTokenRecord;
    } catch {
      const { url } = await startLink(principalId);
      throw new AwsSsoLinkRequiredError(url, "your stored AWS link is unreadable");
    }
    const expired = rec.expiresAtMs !== undefined && now() >= rec.expiresAtMs - skew;
    if (!expired) return rec.accessToken;
    if (!rec.refreshToken) {
      const { url } = await startLink(principalId);
      throw new AwsSsoLinkRequiredError(url, "your AWS session expired and cannot be refreshed");
    }
    let tok: OidcTokenResponse;
    try {
      tok = await exchangeToken({ grant_type: "refresh_token", refresh_token: rec.refreshToken, client_id: requireClientId() });
    } catch {
      const { url } = await startLink(principalId);
      throw new AwsSsoLinkRequiredError(url, "your AWS session expired and the refresh was rejected");
    }
    const updated: AwsSsoTokenRecord = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? rec.refreshToken,
      ...(typeof tok.expires_in === "number" ? { expiresAtMs: now() + tok.expires_in * 1000 } : {}),
      region: rec.region,
      obtainedAtMs: now(),
    };
    await store().write(principalId, JSON.stringify(updated));
    return updated.accessToken;
  }

  interface PortalRoleCredentials {
    readonly roleCredentials?: {
      readonly accessKeyId?: string;
      readonly secretAccessKey?: string;
      readonly sessionToken?: string;
      readonly expiration?: number;
    };
  }

  async function getRoleCredentials(
    accessToken: string,
    principalId: string,
    accountId: string,
    roleName: string,
  ): Promise<AwsCredentials> {
    const u = new URL(portalEndpoint());
    u.searchParams.set("account_id", accountId);
    u.searchParams.set("role_name", roleName);
    let res: Response;
    try {
      res = await fetchImpl(u.toString(), { method: "GET", headers: { "x-amz-sso_bearer_token": accessToken, accept: "application/json" } });
    } catch (err) {
      throw new Error(
        `AWS SSO GetRoleCredentials transport error against ${u.origin}: ${err instanceof Error ? err.message : String(err)}. Fail-closed.`,
      );
    }
    if (res.status === 401) {
      const { url } = await startLink(principalId);
      throw new AwsSsoLinkRequiredError(url, "your AWS session token was rejected");
    }
    if (!res.ok) {
      throw new Error(
        `AWS SSO GetRoleCredentials failed (HTTP ${res.status}) for role "${roleName}" in account ${accountId} — ` +
          `you are not entitled to that role in Identity Center, or the portal refused. Fail-closed: no AWS access.`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as PortalRoleCredentials;
    const rc = body.roleCredentials;
    if (!rc?.accessKeyId || !rc.secretAccessKey || !rc.sessionToken) {
      throw new Error(`AWS SSO GetRoleCredentials returned no role credentials for "${roleName}". Fail-closed.`);
    }
    return {
      accessKeyId: rc.accessKeyId,
      secretAccessKey: rc.secretAccessKey,
      sessionToken: rc.sessionToken,
      ...(typeof rc.expiration === "number" && Number.isFinite(rc.expiration) ? { expiresAtMs: rc.expiration } : {}),
    };
  }

  const warm = warmCredential<{ req: AwsIdentityRequest; principalId: string }>({
    name: "aws.sso-role-credentials",
    platform: "aws",
    auditAction: "aws.sso.mint_failed",
    refresh: "re-mint",
    fallbackTtlSeconds: DEFAULT_CRED_TTL_SECONDS,
    key: ({ req, principalId }) => `user-sso:${req.roleArn}:${principalId}`,
    mint: async ({ req, principalId }) => {
      const { accountId, roleName } = parseRoleArn(req.roleArn);
      const accessToken = await freshAccessToken(principalId);
      const creds = await getRoleCredentials(accessToken, principalId, accountId, roleName);
      return { value: JSON.stringify(creds), ...(creds.expiresAtMs !== undefined ? { expiresAtMs: creds.expiresAtMs } : {}) };
    },
  });

  async function mint(req: AwsIdentityRequest): Promise<AwsCredentials> {
    const principalId = req.principalId;
    if (!principalId) {
      throw new Error("AWS SSO mint: a user-sso request arrived with no principalId — refusing. Fail-closed.");
    }
    const existing = await store().read(principalId);
    if (!existing) {
      const { url } = await startLink(principalId);
      throw new AwsSsoLinkRequiredError(url, "no linked AWS Identity Center identity");
    }
    const serialised = await warm.get({ req, principalId });
    return JSON.parse(serialised) as AwsCredentials;
  }

  return { mint, startLink, completeLink };
}
