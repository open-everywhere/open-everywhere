import type { EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";
import { encryptedKvVault, getSecretVia, OE_OAUTH_CALLBACK_PATH } from "@open-everywhere/core/agent/adapter-api.js";
import { isStaticConfidential, OE_OAUTH_MODE_STATIC, type OeOauthProviderConfig, type OeOauthStaticProviderConfig } from "./config.js";
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
  type ConfidentialClient,
  type OAuthFetch,
  type OAuthTokenResponse,
} from "./oauth-client.js";
import { randomUUID } from "node:crypto";
import { makePkce, makeState } from "./pkce.js";
import { OeOauthNeedsConsentError, OeOauthNeedsReconsentError, OeOauthRefreshContendedError, isInvalidGrant } from "./errors.js";

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
  readonly mode?: typeof OE_OAUTH_MODE_STATIC;
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
}

function subjectKey(subject: OeOauthSubject): string {
  return subject.type === "app" ? "app" : `user:${subject.id}`;
}

function defaultRedirectUri(): string | undefined {
  const base = process.env.OE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return undefined;
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return `${withScheme}${OE_OAUTH_CALLBACK_PATH}`;
}

export function makeOeOauthTokenVault(providers: ReadonlyMap<string, OeOauthProviderConfig>, deps: OeOauthVaultDeps = {}) {
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

  const dcrRef = (providerRef: string) => `oe-oauth:dcr:${providerRef}`;
  const pendRef = (state: string) => `oe-oauth:pend:${state}`;
  const tokRef = (providerRef: string, subject: OeOauthSubject) => `oe-oauth:tok:${providerRef}:${subjectKey(subject)}`;

  function providerConfig(providerRef: string): OeOauthProviderConfig {
    const cfg = providers.get(providerRef);
    if (!cfg) throw new Error(`connection "${providerRef}": no oe-oauth provider config (set OE_OAUTH_CONFIG / OE_OAUTH_NOTION_RESOURCE).`);
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
        throw new Error(`connection "${providerRef}": OE_PUBLIC_BASE_URL is unset — cannot register a DCR client without a redirect_uri.`);
      }
      const endpoints = await discoverEndpoints(cfg.resource, doFetch);
      const { clientId } = await registerClient(
        endpoints.registrationEndpoint,
        { clientName: cfg.clientName ?? "Open Everywhere", redirectUri, ...(cfg.scopes ? { scopes: cfg.scopes } : {}) },
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
    const cfg = providers.get(providerRef);
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

  async function exchangeForPending(pending: PendingRecord, code: string): Promise<OAuthTokenResponse> {
    const cfg = providers.get(pending.providerRef);
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

  async function forget(providerRef: string, subject: OeOauthSubject): Promise<boolean> {
    const ref = tokRef(providerRef, subject);
    return vault.withLock(ref, async () => {
      const rec = await readJson<TokenRecord>(ref);
      if (rec) {
        const cfg = providers.get(providerRef);
        const client: ClientRecord | null = cfg && isStaticConfidential(cfg) ? staticClient(cfg) : await readJson<DcrClientRecord>(dcrRef(providerRef));
        const token = rec.refreshToken ?? rec.accessToken;
        if (client?.revocationEndpoint && token) {
          try {
            const hint = rec.refreshToken ? ("refresh_token" as const) : ("access_token" as const);
            if (cfg && isStaticConfidential(cfg)) {
              await revokeTokenConfidential(client.revocationEndpoint, { token, tokenTypeHint: hint }, await confidentialClientFor(cfg), doFetch);
            } else {
              await revokeToken(client.revocationEndpoint, { token, clientId: client.clientId, tokenTypeHint: hint }, doFetch);
            }
          } catch (e) {
            console.warn(`[oe-oauth] revocation at the provider failed for "${providerRef}" (purging locally anyway): ${e instanceof Error ? e.message : String(e)}`);
          }
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

    async forgetAll(subject: OeOauthSubject): Promise<number> {
      let purged = 0;
      let failures = 0;
      let lastError: unknown;
      for (const providerRef of providers.keys()) {
        try {
          if (await forget(providerRef, subject)) purged++;
        } catch (e) {
          failures++;
          lastError = e;
        }
      }
      if (failures > 0 && purged === 0 && failures === providers.size) throw lastError;
      return purged;
    },

    async hasToken(providerRef: string, subject: OeOauthSubject): Promise<boolean> {
      return (await readJson<TokenRecord>(tokRef(providerRef, subject))) !== null;
    },

    async startAuthorization(
      providerRef: string,
      subject: OeOauthSubject,
      options: { readonly expiresInMs?: number; readonly consent?: unknown },
    ): Promise<{ url: string }> {
      const client = await ensureClient(providerRef);
      const redirectUri = redirectUriOf();
      if (!redirectUri) throw new Error(`connection "${providerRef}": OE_PUBLIC_BASE_URL is unset — cannot build a redirect_uri.`);
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
            const cfg = providers.get(providerRef);
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
