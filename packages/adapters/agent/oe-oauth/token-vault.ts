import type { EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";
import {
  agentDisplayName,
  checkXaaIdentityBinding,
  encryptedKvVault,
  recordXaaRefusal,
  getSecretVia,
  oeOauthCallbackUrl,
  verifyOidcIdToken,
  type XaaBindingVerdict,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  isStaticConfidential,
  isXaa,
  OE_OAUTH_MODE_STATIC,
  OE_OAUTH_MODE_XAA,
  type OeOauthProviderConfig,
  type OeOauthStaticProviderConfig,
  type OeOauthXaaProviderConfig,
} from "./config.js";
import {
  discoverEndpoints,
  registerClient,
  buildAuthorizationUrl,
  buildStaticAuthorizationUrl,
  exchangeCode,
  exchangeCodeConfidential,
  refreshToken,
  refreshTokenConfidential,
  revokeToken,
  revokeTokenConfidential,
  discoverOidc,
  fetchJwks,
  requestIdJag,
  jwtBearerGrant,
  type ConfidentialClient,
  type OidcEndpoints,
  type OAuthFetch,
  type OAuthTokenResponse,
} from "./oauth-client.js";
import { createHash, randomUUID } from "node:crypto";
import { makePkce, makeState } from "./pkce.js";
import { OeOauthAccessRemovedError, OeOauthNeedsConsentError, OeOauthNeedsReconsentError, OeOauthRefreshContendedError, isInvalidGrant } from "./errors.js";

export type OeOauthSubject = { readonly type: "user"; readonly id: string } | { readonly type: "app" };

interface DcrClientRecord {
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly resource: string;
  readonly scopes?: readonly string[];
  readonly registeredAt: number;
  readonly redirectUri?: string;
}

interface StaticClientRecord {
  readonly mode: typeof OE_OAUTH_MODE_STATIC;
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly scopes?: readonly string[];
  readonly authorizeParams?: Readonly<Record<string, string>>;
}

type ClientRecord = DcrClientRecord | StaticClientRecord;

function isStaticClient(rec: ClientRecord): rec is StaticClientRecord {
  return (rec as StaticClientRecord).mode === OE_OAUTH_MODE_STATIC;
}

interface PendingRecord {
  readonly providerRef: string;
  readonly subject: OeOauthSubject;
  readonly pkceVerifier: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly resource?: string;
  readonly mode?: typeof OE_OAUTH_MODE_STATIC | typeof OE_OAUTH_MODE_XAA;
  readonly nonce?: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumed?: boolean;
  readonly consent?: unknown;
}

interface PendingSweepReport {
  readonly scanned: number;
  readonly deleted: number;
  readonly live: number;
  readonly unreadable: number;
}

interface IdpGrantRecord {
  readonly refreshToken: string;
  readonly idpSubject: string;
  readonly obtainedAt: number;
}

const XAA_IDP_SCOPES = ["openid", "offline_access"] as const;

const XAA_IDP_REFUSALS: ReadonlySet<string> = new Set(["access_denied", "unauthorized_client", "invalid_target"]);
const XAA_APP_REFUSALS: ReadonlySet<string> = new Set(["invalid_grant", "access_denied", "unauthorized_client"]);

const OIDC_DISCOVERY_TTL_MS = 60 * 60 * 1000;

interface TokenRecord {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
  readonly obtainedAt: number;
}

const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;
const DEFAULT_EXPIRY_SKEW_MS = 60 * 1000;

const DEFAULT_PENDING_RETENTION_MS = 60 * 60 * 1000;

export const CLAIM_LEASE_TTL_MS = 30_000;
const LOSER_WAIT_BUDGET_MS = 15_000;
const LOSER_POLL_MS = 250;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface OeOauthVaultDeps {
  readonly vault?: EncryptedKvVault;
  readonly fetch?: OAuthFetch;
  readonly now?: () => number;
  readonly newState?: () => string;
  readonly newPkce?: () => { readonly verifier: string; readonly challenge: string };
  readonly redirectUri?: () => string | undefined;
  readonly pendingTtlMs?: number;
  readonly pendingRetentionMs?: number;
  readonly expirySkewMs?: number;
  readonly newClaimId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly resolveSecret?: (broker: string | undefined, ref: string) => Promise<string>;
  readonly newNonce?: () => string;
  readonly verifyIdToken?: typeof verifyOidcIdToken;
  readonly bindIdentity?: (input: {
    readonly principalSubject: string;
    readonly signerSubject: string | undefined;
    readonly connection: string;
    readonly stage?: "sign-in" | "mint";
  }) => Promise<XaaBindingVerdict>;
  readonly recordRefusal?: typeof recordXaaRefusal;
}

function subjectKey(subject: OeOauthSubject): string {
  return subject.type === "app" ? "app" : `user:${subject.id}`;
}

function defaultRedirectUri(): string | undefined {
  return oeOauthCallbackUrl();
}

export type OeOauthProviderSource = ReadonlyMap<string, OeOauthProviderConfig> | (() => ReadonlyMap<string, OeOauthProviderConfig>);

export function makeOeOauthTokenVault(source: OeOauthProviderSource, deps: OeOauthVaultDeps = {}) {
  const providersNow = typeof source === "function" ? source : () => source;
  const vault = deps.vault ?? encryptedKvVault();
  const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const newState = deps.newState ?? makeState;
  const newPkce = deps.newPkce ?? makePkce;
  const redirectUriOf = deps.redirectUri ?? defaultRedirectUri;
  const pendingTtl = deps.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const pendingRetention = deps.pendingRetentionMs ?? DEFAULT_PENDING_RETENTION_MS;
  const skew = deps.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
  const newClaimId = deps.newClaimId ?? (() => randomUUID());
  const sleep = deps.sleep ?? realSleep;
  const resolveSecret = deps.resolveSecret ?? ((broker: string | undefined, ref: string) => getSecretVia(broker, ref));
  const newNonce = deps.newNonce ?? makeState;
  const verifyIdToken = deps.verifyIdToken ?? verifyOidcIdToken;
  const bindIdentity = deps.bindIdentity ?? checkXaaIdentityBinding;
  const recordRefusal = deps.recordRefusal ?? recordXaaRefusal;

  const dcrRef = (providerRef: string) => `oe-oauth:dcr:${providerRef}`;
  const pendRef = (state: string) => `oe-oauth:pend:${state}`;
  const tokRef = (providerRef: string, subject: OeOauthSubject) => `oe-oauth:tok:${providerRef}:${subjectKey(subject)}`;
  const idpKey = (cfg: OeOauthXaaProviderConfig) => createHash("sha256").update(`${cfg.idpIssuer}\n${cfg.idpClientId}`).digest("hex").slice(0, 32);
  const idpRef = (cfg: OeOauthXaaProviderConfig, subject: OeOauthSubject) => `oe-oauth:xaa-idp:${idpKey(cfg)}:${subjectKey(subject)}`;

  function providerConfig(providerRef: string): OeOauthProviderConfig {
    const cfg = providersNow().get(providerRef);
    if (!cfg) {
      throw new Error(
        `connection "${providerRef}": no sign-in is declared for this OAuth home — the connector's connection module declares one with declareConnectionSignIn (core connections/connection-sign-in.ts).`,
      );
    }
    return cfg;
  }

  async function readJson<T>(ref: string): Promise<T | null> {
    const raw = await vault.read(ref);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  function dcrRecordNeedsBackfill(rec: DcrClientRecord): boolean {
    return rec.revocationEndpoint === undefined;
  }

  async function ensureDcrClient(providerRef: string): Promise<DcrClientRecord> {
    const existing = await readJson<DcrClientRecord>(dcrRef(providerRef));
    if (existing && !dcrRecordNeedsBackfill(existing)) return existing;
    const cfg = providerConfig(providerRef);
    if (isStaticConfidential(cfg)) throw new Error(`connection "${providerRef}": declares the "${OE_OAUTH_MODE_STATIC}" mode, which registers no dynamic client.`);
    if (isXaa(cfg)) throw new Error(`connection "${providerRef}": declares the "${OE_OAUTH_MODE_XAA}" mode, which registers no dynamic client.`);
    return vault.withLock(dcrRef(providerRef), async () => {
      const again = await readJson<DcrClientRecord>(dcrRef(providerRef));
      if (again && !dcrRecordNeedsBackfill(again)) return again;
      if (again) {
        try {
          const endpoints = await discoverEndpoints(cfg.resource, doFetch);
          if (endpoints.revocationEndpoint === undefined) return again;
          const backfilled: DcrClientRecord = { ...again, revocationEndpoint: endpoints.revocationEndpoint };
          await vault.write(dcrRef(providerRef), JSON.stringify(backfilled), { connector: providerRef });
          return backfilled;
        } catch (e) {
          console.warn(`[oe-oauth] DCR backfill discovery failed for "${providerRef}" (using the frozen record): ${e instanceof Error ? e.message : String(e)}`);
          return again;
        }
      }
      const redirectUri = redirectUriOf();
      if (!redirectUri) {
        throw new Error(`connection "${providerRef}": this deployment has no public URL (set OE_PUBLIC_BASE_URL) — cannot register a DCR client without a redirect_uri.`);
      }
      const endpoints = await discoverEndpoints(cfg.resource, doFetch);
      const { clientId } = await registerClient(
        endpoints.registrationEndpoint,
        { clientName: cfg.clientName ?? agentDisplayName(), redirectUri, ...(cfg.scopes ? { scopes: cfg.scopes } : {}) },
        doFetch,
      );
      const record: DcrClientRecord = {
        clientId,
        authorizationEndpoint: endpoints.authorizationEndpoint,
        tokenEndpoint: endpoints.tokenEndpoint,
        registrationEndpoint: endpoints.registrationEndpoint,
        ...(endpoints.revocationEndpoint ? { revocationEndpoint: endpoints.revocationEndpoint } : {}),
        resource: cfg.resource,
        ...(cfg.scopes ? { scopes: cfg.scopes } : {}),
        registeredAt: now(),
        redirectUri,
      };
      await vault.write(dcrRef(providerRef), JSON.stringify(record), { connector: providerRef });
      return record;
    });
  }

  function staticClient(cfg: OeOauthStaticProviderConfig): StaticClientRecord {
    return {
      mode: OE_OAUTH_MODE_STATIC,
      clientId: cfg.clientId,
      authorizationEndpoint: cfg.authorizationEndpoint,
      tokenEndpoint: cfg.tokenEndpoint,
      ...(cfg.revocationEndpoint ? { revocationEndpoint: cfg.revocationEndpoint } : {}),
      ...(cfg.scopes ? { scopes: cfg.scopes } : {}),
      ...(cfg.authorizeParams ? { authorizeParams: cfg.authorizeParams } : {}),
    };
  }

  async function ensureClient(providerRef: string): Promise<ClientRecord> {
    const cfg = providersNow().get(providerRef);
    return cfg !== undefined && isStaticConfidential(cfg) ? staticClient(cfg) : ensureDcrClient(providerRef);
  }

  async function confidentialClientFor(cfg: OeOauthStaticProviderConfig): Promise<ConfidentialClient> {
    const secret = await resolveSecret(cfg.clientSecretBroker, cfg.clientSecretRef);
    if (typeof secret !== "string" || secret === "") {
      throw new Error(
        `connection "${cfg.ref}": the OAuth client secret at ref "${cfg.clientSecretRef}" (broker "${cfg.clientSecretBroker}") has no stored value — ` +
          `store it with \`oe secret set ${cfg.clientSecretRef}\` before this connection can mint a token.`,
      );
    }
    return {
      clientId: cfg.clientId,
      clientSecret: secret,
      bodyEncoding: cfg.bodyEncoding,
      ...(cfg.tokenHeaders ? { headers: cfg.tokenHeaders } : {}),
    };
  }

  async function xaaClient(cfg: OeOauthXaaProviderConfig, leg: "idp" | "app"): Promise<ConfidentialClient> {
    const [clientId, secretRef, broker] =
      leg === "idp" ? [cfg.idpClientId, cfg.idpClientSecretRef, cfg.idpClientSecretBroker] : [cfg.resourceClientId, cfg.resourceClientSecretRef, cfg.resourceClientSecretBroker];
    const secret = await resolveSecret(broker, secretRef);
    if (typeof secret !== "string" || secret === "") {
      throw new Error(
        `connection "${cfg.ref}": the ${leg === "idp" ? "identity-provider" : "app"} client secret at ref "${secretRef}" (broker "${broker}") has no stored value — ` +
          `store it with \`oe secret set ${secretRef}\` before this connection can mint a token.`,
      );
    }
    return { clientId, clientSecret: secret, bodyEncoding: "form" };
  }

  const oidcCache = new Map<string, { readonly at: number; readonly endpoints: OidcEndpoints }>();
  async function oidcFor(cfg: OeOauthXaaProviderConfig): Promise<OidcEndpoints> {
    const hit = oidcCache.get(cfg.idpIssuer);
    if (hit && now() - hit.at < OIDC_DISCOVERY_TTL_MS) return hit.endpoints;
    const endpoints = await discoverOidc(cfg.idpIssuer, doFetch);
    oidcCache.set(cfg.idpIssuer, { at: now(), endpoints });
    return endpoints;
  }

  function requireXaaPerson(providerRef: string, subject: OeOauthSubject): asserts subject is { readonly type: "user"; readonly id: string } {
    if (subject.type !== "user") {
      throw new Error(`connection "${providerRef}": the "${OE_OAUTH_MODE_XAA}" sign-in acts only as a person — it has no service account to mint for.`);
    }
  }

  async function xaaStartAuthorization(
    cfg: OeOauthXaaProviderConfig,
    subject: OeOauthSubject,
    options: { readonly expiresInMs?: number; readonly consent?: unknown },
  ): Promise<{ url: string }> {
    requireXaaPerson(cfg.ref, subject);
    const oidc = await oidcFor(cfg);
    const redirectUri = redirectUriOf();
    if (!redirectUri) throw new Error(`connection "${cfg.ref}": this deployment has no public URL (set OE_PUBLIC_BASE_URL) — cannot build a redirect_uri.`);
    const state = newState();
    const pkce = newPkce();
    const nonce = newNonce();
    const pending: PendingRecord = {
      providerRef: cfg.ref,
      subject,
      pkceVerifier: pkce.verifier,
      tokenEndpoint: oidc.tokenEndpoint,
      clientId: cfg.idpClientId,
      mode: OE_OAUTH_MODE_XAA,
      nonce,
      redirectUri,
      scopes: XAA_IDP_SCOPES,
      createdAt: now(),
      expiresAt: now() + (options.expiresInMs ?? pendingTtl),
      ...(options.consent ? { consent: options.consent } : {}),
    };
    await vault.write(pendRef(state), JSON.stringify(pending), { connector: cfg.ref });
    const url = buildStaticAuthorizationUrl({
      authorizationEndpoint: oidc.authorizationEndpoint,
      clientId: cfg.idpClientId,
      redirectUri,
      state,
      scopes: XAA_IDP_SCOPES,
      extraParams: { nonce, code_challenge: pkce.challenge, code_challenge_method: "S256" },
    });
    return { url };
  }

  async function xaaCompleteAuthorization(state: string, pending: PendingRecord, code: string): Promise<{ rebound: boolean }> {
    const cfg = providersNow().get(pending.providerRef);
    if (cfg === undefined || !isXaa(cfg) || cfg.idpClientId !== pending.clientId) {
      throw new Error(`connection "${pending.providerRef}": this sign-in started under an "${OE_OAUTH_MODE_XAA}" declaration that no longer stands — start again.`);
    }
    const spend = () => vault.write(pendRef(state), JSON.stringify({ ...pending, consumed: true, pkceVerifier: "", nonce: "", consent: undefined }), { connector: pending.providerRef });
    const tok = await exchangeCodeConfidential(pending.tokenEndpoint, { code, redirectUri: pending.redirectUri, codeVerifier: pending.pkceVerifier }, await xaaClient(cfg, "idp"), doFetch);
    let signer: string | undefined;
    try {
      if (!tok.id_token) throw new Error("the IdP returned no id token");
      const oidc = await oidcFor(cfg);
      signer = (await verifyIdToken(tok.id_token, { jwks: (await fetchJwks(oidc.jwksUri, doFetch)) as Parameters<typeof verifyOidcIdToken>[1]["jwks"], issuer: cfg.idpIssuer, audience: cfg.idpClientId, nonce: pending.nonce ?? "" })).sub;
    } catch (e) {
      await spend();
      const reason = e instanceof Error ? e.message : String(e);
      if (pending.subject.type === "user") await recordRefusal({ principalSubject: pending.subject.id, connection: pending.providerRef, reason });
      throw new Error(`connection "${pending.providerRef}": the identity-provider sign-in was refused — ${reason}.`);
    }
    if (pending.subject.type !== "user") {
      await spend();
      throw new Error(`connection "${pending.providerRef}": the "${OE_OAUTH_MODE_XAA}" sign-in acts only as a person.`);
    }
    const verdict = await bindIdentity({ principalSubject: pending.subject.id, signerSubject: signer, connection: pending.providerRef });
    if (!verdict.ok) {
      await spend();
      throw new Error(`connection "${pending.providerRef}": the identity-provider sign-in was refused — ${verdict.reason}.`);
    }
    if (!tok.refresh_token) {
      await spend();
      await recordRefusal({ principalSubject: pending.subject.id, connection: pending.providerRef, reason: "the IdP returned no refresh token", signerSubject: verdict.idpNativeId });
      throw new Error(`connection "${pending.providerRef}": the IdP returned no refresh token — the OE app at the IdP must allow the refresh-token grant and the offline_access scope.`);
    }
    const gRef = idpRef(cfg, pending.subject);
    const rebound = (await readJson<IdpGrantRecord>(gRef)) !== null;
    const grant: IdpGrantRecord = { refreshToken: tok.refresh_token, idpSubject: verdict.idpNativeId, obtainedAt: now() };
    await vault.write(gRef, JSON.stringify(grant), { connector: pending.providerRef });
    await spend();
    return { rebound };
  }

  function oauthErrorOf(e: unknown): string | undefined {
    const code = (e as { oauthError?: unknown } | null)?.oauthError;
    return typeof code === "string" ? code.toLowerCase() : undefined;
  }

  async function xaaMint(cfg: OeOauthXaaProviderConfig, providerRef: string, subject: OeOauthSubject, grant: IdpGrantRecord): Promise<string> {
    const oidc = await oidcFor(cfg);
    const legParams = { ...(cfg.resource ? { resource: cfg.resource } : {}), ...(cfg.scopes ? { scopes: cfg.scopes } : {}) };
    let idJag: string;
    try {
      idJag = await requestIdJag(oidc.tokenEndpoint, { subjectToken: grant.refreshToken, audience: cfg.audience, ...legParams }, await xaaClient(cfg, "idp"), doFetch);
    } catch (e) {
      const code = oauthErrorOf(e);
      if (code === "invalid_grant") throw new OeOauthNeedsReconsentError(providerRef, subject, "the identity-provider sign-in is no longer valid (invalid_grant)");
      if (code !== undefined && XAA_IDP_REFUSALS.has(code)) throw new OeOauthAccessRemovedError(providerRef, subject, "idp", code);
      throw e;
    }
    let tok: OAuthTokenResponse;
    try {
      tok = await jwtBearerGrant(cfg.resourceTokenEndpoint, { assertion: idJag, ...legParams }, await xaaClient(cfg, "app"), doFetch);
    } catch (e) {
      const code = oauthErrorOf(e);
      if (code !== undefined && XAA_APP_REFUSALS.has(code)) throw new OeOauthAccessRemovedError(providerRef, subject, "app", code);
      throw e;
    }
    const { refresh_token: _ignored, ...withoutRefresh } = tok;
    return (await storeToken(providerRef, subject, withoutRefresh)).accessToken;
  }

  async function xaaAccessTokenFor(cfg: OeOauthXaaProviderConfig, providerRef: string, subject: OeOauthSubject): Promise<string> {
    requireXaaPerson(providerRef, subject);
    const ref = tokRef(providerRef, subject);
    const fast = await readJson<TokenRecord>(ref);
    if (fast && !isExpired(fast)) return fast.accessToken;
    const gRef = idpRef(cfg, subject);
    return vault.withLock(ref, async () => {
      const deadline = now() + LOSER_WAIT_BUDGET_MS;
      for (;;) {
        const rec = await readJson<TokenRecord>(ref);
        if (rec && !isExpired(rec)) return rec.accessToken;
        const grant = await readJson<IdpGrantRecord>(gRef);
        if (!grant) throw new OeOauthNeedsConsentError(providerRef, subject);
        const claimId = newClaimId();
        if (await vault.claim(gRef, claimId, now(), CLAIM_LEASE_TTL_MS)) {
          try {
            const won = await readJson<TokenRecord>(ref);
            if (won && !isExpired(won)) return won.accessToken;
            const still = await bindIdentity({ principalSubject: subject.id, signerSubject: grant.idpSubject, connection: providerRef, stage: "mint" });
            if (!still.ok && still.unreadable) {
              throw new Error(`connection "${providerRef}": the identity-link plane could not be read, so the Okta grant could not be re-checked — retry.`);
            }
            if (!still.ok) {
              await vault.delete(gRef);
              throw new OeOauthNeedsConsentError(providerRef, subject);
            }
            return await xaaMint(cfg, providerRef, subject, grant);
          } finally {
            await vault.releaseClaim(gRef, claimId);
          }
        }
        if (now() >= deadline) throw new OeOauthRefreshContendedError(providerRef, subject);
        await sleep(LOSER_POLL_MS);
      }
    });
  }

  function idpReportRef(cfg: OeOauthXaaProviderConfig): string {
    try {
      return `idp:${new URL(cfg.idpIssuer).host}`;
    } catch {
      return "idp:";
    }
  }

  async function revokeWithRetry(providerRef: string, call: () => Promise<void>, onUnrevoked: ((providerRef: string) => void) | undefined, what: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await call();
        return;
      } catch (e) {
        if (attempt < 2) continue;
        console.warn(`[oe-oauth] ${what} failed twice for "${providerRef}" (purging locally anyway; the token stays valid there until it expires): ${e instanceof Error ? e.message : String(e)}`);
        onUnrevoked?.(providerRef);
        return;
      }
    }
  }

  async function forgetIdpGrant(cfg: OeOauthXaaProviderConfig, subject: OeOauthSubject, onUnrevoked?: (providerRef: string) => void): Promise<boolean> {
    const gRef = idpRef(cfg, subject);
    return vault.withLock(gRef, async () => {
      const grant = await readJson<IdpGrantRecord>(gRef);
      if (grant) {
        await revokeWithRetry(
          idpReportRef(cfg),
          async () => {
            const oidc = await oidcFor(cfg);
            if (oidc.revocationEndpoint) {
              await revokeTokenConfidential(oidc.revocationEndpoint, { token: grant.refreshToken, tokenTypeHint: "refresh_token" }, await xaaClient(cfg, "idp"), doFetch);
            }
          },
          onUnrevoked,
          "IdP revocation",
        );
      }
      return vault.delete(gRef);
    });
  }

  async function exchangeForPending(pending: PendingRecord, code: string): Promise<OAuthTokenResponse> {
    const cfg = providersNow().get(pending.providerRef);
    if (cfg !== undefined && isXaa(cfg)) {
      throw new Error(`connection "${pending.providerRef}": this authorization started under another dialect, but the provider config now declares "${OE_OAUTH_MODE_XAA}" — start again.`);
    }
    const startedStatic = pending.mode === OE_OAUTH_MODE_STATIC;
    if (cfg !== undefined && isStaticConfidential(cfg) !== startedStatic) {
      throw new Error(
        `connection "${pending.providerRef}": this authorization started as ${startedStatic ? "a static confidential client" : "a public PKCE client"}, ` +
          `but the provider config no longer declares that mode — start again.`,
      );
    }
    if (startedStatic) {
      if (cfg === undefined || !isStaticConfidential(cfg)) {
        throw new Error(`connection "${pending.providerRef}": no static confidential provider config, so the client that started this authorization cannot be resolved — start again.`);
      }
      return exchangeCodeConfidential(pending.tokenEndpoint, { code, redirectUri: pending.redirectUri }, await confidentialClientFor(cfg), doFetch);
    }
    if (!pending.resource) throw new Error(`connection "${pending.providerRef}": this authorization record carries no resource indicator — start again.`);
    return exchangeCode(pending.tokenEndpoint, { code, verifier: pending.pkceVerifier, clientId: pending.clientId, redirectUri: pending.redirectUri, resource: pending.resource }, doFetch);
  }

  function isExpired(rec: TokenRecord): boolean {
    return rec.expiresAt !== undefined && now() >= rec.expiresAt - skew;
  }

  async function storeToken(providerRef: string, subject: OeOauthSubject, tok: OAuthTokenResponse, priorRefresh?: string): Promise<TokenRecord> {
    const refresh = tok.refresh_token ?? priorRefresh;
    const record: TokenRecord = {
      accessToken: tok.access_token,
      ...(refresh ? { refreshToken: refresh } : {}),
      ...(typeof tok.expires_in === "number" ? { expiresAt: now() + tok.expires_in * 1000 } : {}),
      ...(tok.scope ? { scopes: tok.scope.split(/\s+/).filter(Boolean) } : {}),
      obtainedAt: now(),
    };
    await vault.write(tokRef(providerRef, subject), JSON.stringify(record), { connector: providerRef });
    return record;
  }

  async function forget(providerRef: string, subject: OeOauthSubject, onUnrevoked?: (providerRef: string) => void): Promise<boolean> {
    const ref = tokRef(providerRef, subject);
    return vault.withLock(ref, async () => {
      const rec = await readJson<TokenRecord>(ref);
      if (rec) {
        const cfg = providersNow().get(providerRef);
        const client: ClientRecord | null = cfg && isStaticConfidential(cfg) ? staticClient(cfg) : await readJson<DcrClientRecord>(dcrRef(providerRef));
        const token = rec.refreshToken ?? rec.accessToken;
        if (client?.revocationEndpoint && token) {
          const endpoint = client.revocationEndpoint;
          const hint = rec.refreshToken ? ("refresh_token" as const) : ("access_token" as const);
          await revokeWithRetry(
            providerRef,
            async () => {
              if (cfg && isStaticConfidential(cfg)) {
                await revokeTokenConfidential(endpoint, { token, tokenTypeHint: hint }, await confidentialClientFor(cfg), doFetch);
              } else {
                await revokeToken(endpoint, { token, clientId: client.clientId, tokenTypeHint: hint }, doFetch);
              }
            },
            onUnrevoked,
            "revocation at the provider",
          );
        }
      }
      return vault.delete(ref);
    });
  }

  async function sweepExpiredPending(): Promise<PendingSweepReport> {
    const refs = await vault.listRefs("oe-oauth:pend:");
    let deleted = 0;
    let live = 0;
    let unreadable = 0;
    for (const ref of refs) {
      let rec: PendingRecord | null;
      try {
        rec = await readJson<PendingRecord>(ref);
      } catch {
        unreadable++;
        continue;
      }
      if (!rec || typeof rec.expiresAt !== "number" || !Number.isFinite(rec.expiresAt)) {
        unreadable++;
        continue;
      }
      if (now() <= rec.expiresAt + pendingRetention) {
        live++;
        continue;
      }
      if (await vault.delete(ref)) deleted++;
    }
    return { scanned: refs.length, deleted, live, unreadable };
  }

  return {
    subjectKey,

    forget,

    sweepExpiredPending,

    async forgetAll(subject: OeOauthSubject, onUnrevoked?: (providerRef: string) => void): Promise<number> {
      let purged = 0;
      let failures = 0;
      let lastError: unknown;
      const all = providersNow();
      for (const providerRef of all.keys()) {
        try {
          if (await forget(providerRef, subject, onUnrevoked)) purged++;
        } catch (e) {
          failures++;
          lastError = e;
        }
      }
      const tokPrefix = "oe-oauth:tok:";
      const tokSuffix = `:${subjectKey(subject)}`;
      let undeclaredAttempts = 0;
      try {
        for (const ref of await vault.listRefs(tokPrefix)) {
          if (!ref.endsWith(tokSuffix)) continue;
          const providerRef = ref.slice(tokPrefix.length, ref.length - tokSuffix.length);
          if (providerRef.length === 0 || providerRef.includes(":") || all.has(providerRef)) continue;
          undeclaredAttempts++;
          try {
            if (await forget(providerRef, subject, onUnrevoked)) purged++;
          } catch (e) {
            failures++;
            lastError = e;
          }
        }
      } catch (e) {
        failures++;
        lastError = e;
        undeclaredAttempts++;
      }
      const seenIdp = new Set<string>();
      for (const cfg of all.values()) {
        if (!isXaa(cfg) || seenIdp.has(idpKey(cfg))) continue;
        seenIdp.add(idpKey(cfg));
        try {
          if (await forgetIdpGrant(cfg, subject, onUnrevoked)) purged++;
        } catch (e) {
          failures++;
          lastError = e;
        }
      }
      const covered = new Set([...all.values()].filter(isXaa).map((cfg) => idpRef(cfg, subject)));
      const orphanRef = /^oe-oauth:xaa-idp:[0-9a-f]{32}:(.*)$/u;
      let orphanFailed = false;
      try {
        for (const ref of await vault.listRefs("oe-oauth:xaa-idp:")) {
          if (orphanRef.exec(ref)?.[1] !== subjectKey(subject) || covered.has(ref)) continue;
          console.warn(`[oe-oauth] an IdP grant with no declared xaa connection was deleted locally — it could not be revoked at the IdP.`);
          if (await vault.delete(ref)) purged++;
        }
      } catch (e) {
        failures++;
        lastError = e;
        orphanFailed = true;
      }
      if (failures > 0 && purged === 0 && failures === all.size + undeclaredAttempts + seenIdp.size + (orphanFailed ? 1 : 0)) throw lastError;
      return purged;
    },

    async hasToken(providerRef: string, subject: OeOauthSubject): Promise<boolean> {
      if ((await readJson<TokenRecord>(tokRef(providerRef, subject))) !== null) return true;
      const cfg = providersNow().get(providerRef);
      return cfg !== undefined && isXaa(cfg) && (await readJson<IdpGrantRecord>(idpRef(cfg, subject))) !== null;
    },

    async startAuthorization(
      providerRef: string,
      subject: OeOauthSubject,
      options: { readonly expiresInMs?: number; readonly consent?: unknown },
    ): Promise<{ url: string }> {
      const xaaCfg = providersNow().get(providerRef);
      if (xaaCfg !== undefined && isXaa(xaaCfg)) {
        const out = await xaaStartAuthorization(xaaCfg, subject, options);
        try {
          await sweepExpiredPending();
        } catch (e) {
          console.warn(`[oe-oauth] the expired-pending sweep failed (the authorization URL is unaffected): ${e instanceof Error ? e.message : String(e)}`);
        }
        return out;
      }
      const client = await ensureClient(providerRef);
      let redirectUri = redirectUriOf();
      if (!redirectUri) throw new Error(`connection "${providerRef}": this deployment has no public URL (set OE_PUBLIC_BASE_URL) — cannot build a redirect_uri.`);
      if (!isStaticClient(client) && client.redirectUri !== undefined && client.redirectUri !== redirectUri) {
        console.warn(`[oe-oauth] connection "${providerRef}": its dynamic client registered with ${client.redirectUri}; this deployment's callback is now ${redirectUri}. Sending the registered one.`);
        redirectUri = client.redirectUri;
      }
      const state = newState();
      const pkce = isStaticClient(client) ? { verifier: "", challenge: "" } : newPkce();
      const pending: PendingRecord = {
        providerRef,
        subject,
        pkceVerifier: pkce.verifier,
        tokenEndpoint: client.tokenEndpoint,
        clientId: client.clientId,
        ...(isStaticClient(client) ? { mode: OE_OAUTH_MODE_STATIC } : { resource: client.resource }),
        redirectUri,
        ...(client.scopes ? { scopes: client.scopes } : {}),
        createdAt: now(),
        expiresAt: now() + (options.expiresInMs ?? pendingTtl),
        ...(options.consent ? { consent: options.consent } : {}),
      };
      await vault.write(pendRef(state), JSON.stringify(pending), { connector: providerRef });
      const url = isStaticClient(client)
        ? buildStaticAuthorizationUrl({
            authorizationEndpoint: client.authorizationEndpoint,
            clientId: client.clientId,
            redirectUri,
            state,
            ...(client.scopes ? { scopes: client.scopes } : {}),
            ...(client.authorizeParams ? { extraParams: client.authorizeParams } : {}),
          })
        : buildAuthorizationUrl({
            authorizationEndpoint: client.authorizationEndpoint,
            clientId: client.clientId,
            redirectUri,
            state,
            codeChallenge: pkce.challenge,
            resource: client.resource,
            ...(client.scopes ? { scopes: client.scopes } : {}),
          });
      try {
        await sweepExpiredPending();
      } catch (e) {
        console.warn(`[oe-oauth] the expired-pending sweep failed (the authorization URL is unaffected): ${e instanceof Error ? e.message : String(e)}`);
      }
      return { url };
    },

    async completeAuthorization(state: string, code: string): Promise<{ providerRef: string; subject: OeOauthSubject; rebound: boolean; consent?: unknown }> {
      const pending = await readJson<PendingRecord>(pendRef(state));
      if (!pending) throw new Error("unknown or expired authorization state");
      if (pending.consumed) throw new Error("authorization state already used");
      if (now() > pending.expiresAt) throw new Error("authorization state expired");
      if (pending.mode === OE_OAUTH_MODE_XAA) {
        const { rebound } = await xaaCompleteAuthorization(state, pending, code);
        return { providerRef: pending.providerRef, subject: pending.subject, rebound, ...(pending.consent ? { consent: pending.consent } : {}) };
      }
      const tok = await exchangeForPending(pending, code);
      const rebound = (await readJson<TokenRecord>(tokRef(pending.providerRef, pending.subject))) !== null;
      await storeToken(pending.providerRef, pending.subject, tok);
      await vault.write(
        pendRef(state),
        JSON.stringify({ ...pending, consumed: true, pkceVerifier: "", consent: undefined }),
        { connector: pending.providerRef },
      );
      return { providerRef: pending.providerRef, subject: pending.subject, rebound, ...(pending.consent ? { consent: pending.consent } : {}) };
    },

    async accessTokenFor(providerRef: string, subject: OeOauthSubject): Promise<string> {
      const xaaCfg = providersNow().get(providerRef);
      if (xaaCfg !== undefined && isXaa(xaaCfg)) return xaaAccessTokenFor(xaaCfg, providerRef, subject);
      const ref = tokRef(providerRef, subject);
      const fast = await readJson<TokenRecord>(ref);
      if (!fast) throw new OeOauthNeedsConsentError(providerRef, subject);
      if (!isExpired(fast)) return fast.accessToken;

      return vault.withLock(ref, async () => {
        const rec = await readJson<TokenRecord>(ref);
        if (!rec) throw new OeOauthNeedsConsentError(providerRef, subject);
        if (!isExpired(rec)) return rec.accessToken;
        if (!rec.refreshToken) throw new OeOauthNeedsReconsentError(providerRef, subject, "no refresh token stored");
        const presentedRefresh = rec.refreshToken;

        const claimId = newClaimId();
        const won = await vault.claim(ref, claimId, now(), CLAIM_LEASE_TTL_MS);
        if (won) {
          try {
            const cfg = providersNow().get(providerRef);
            let tok: OAuthTokenResponse;
            try {
              if (cfg !== undefined && isStaticConfidential(cfg)) {
                tok = await refreshTokenConfidential(
                  cfg.tokenEndpoint,
                  { refreshToken: presentedRefresh, ...(cfg.scopes ? { scopes: cfg.scopes } : {}) },
                  await confidentialClientFor(cfg),
                  doFetch,
                );
              } else {
                const client = await ensureDcrClient(providerRef);
                tok = await refreshToken(
                  client.tokenEndpoint,
                  { refreshToken: presentedRefresh, clientId: client.clientId, resource: client.resource, ...(client.scopes ? { scopes: client.scopes } : {}) },
                  doFetch,
                );
              }
            } catch (e) {
              if (isInvalidGrant(e)) {
                const rec2 = await readJson<TokenRecord>(ref);
                if (rec2 && !isExpired(rec2) && rec2.refreshToken !== rec.refreshToken) return rec2.accessToken;
                throw new OeOauthNeedsReconsentError(providerRef, subject, "refresh token rejected (invalid_grant)");
              }
              throw e;
            }
            const stored = await storeToken(providerRef, subject, tok, rec.refreshToken);
            return stored.accessToken;
          } finally {
            await vault.releaseClaim(ref, claimId);
          }
        }

        const deadline = now() + LOSER_WAIT_BUDGET_MS;
        for (;;) {
          const rec2 = await readJson<TokenRecord>(ref);
          if (rec2 && !isExpired(rec2)) return rec2.accessToken;
          if (now() >= deadline) throw new OeOauthRefreshContendedError(providerRef, subject);
          await sleep(LOSER_POLL_MS);
        }
      });
    },
  };
}

export type OeOauthTokenVault = ReturnType<typeof makeOeOauthTokenVault>;
