import type { EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";
import { encryptedKvVault, OE_OAUTH_CALLBACK_PATH } from "@open-everywhere/core/agent/adapter-api.js";
import type { OeOauthProviderConfig } from "./config.js";
import {
  discoverEndpoints,
  registerClient,
  buildAuthorizationUrl,
  exchangeCode,
  refreshToken,
  revokeToken,
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

interface PendingRecord {
  readonly providerRef: string;
  readonly subject: OeOauthSubject;
  readonly pkceVerifier: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly resource: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumed?: boolean;
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
  readonly expirySkewMs?: number;
  readonly newClaimId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
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
  const skew = deps.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
  const newClaimId = deps.newClaimId ?? (() => randomUUID());
  const sleep = deps.sleep ?? realSleep;

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

  async function ensureDcrClient(providerRef: string): Promise<DcrClientRecord> {
    const existing = await readJson<DcrClientRecord>(dcrRef(providerRef));
    if (existing) return existing;
    const cfg = providerConfig(providerRef);
    return vault.withLock(dcrRef(providerRef), async () => {
      const again = await readJson<DcrClientRecord>(dcrRef(providerRef));
      if (again) return again;
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
      await vault.write(dcrRef(providerRef), JSON.stringify(record), { provider: providerRef });
      return record;
    });
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
    await vault.write(tokRef(providerRef, subject), JSON.stringify(record), { provider: providerRef });
    return record;
  }

  async function forget(providerRef: string, subject: OeOauthSubject): Promise<boolean> {
    const ref = tokRef(providerRef, subject);
    return vault.withLock(ref, async () => {
      const rec = await readJson<TokenRecord>(ref);
      if (rec) {
        const client = await readJson<DcrClientRecord>(dcrRef(providerRef));
        const token = rec.refreshToken ?? rec.accessToken;
        if (client?.revocationEndpoint && token) {
          try {
            await revokeToken(client.revocationEndpoint, { token, clientId: client.clientId, tokenTypeHint: rec.refreshToken ? "refresh_token" : "access_token" }, doFetch);
          } catch (e) {
            console.warn(`[oe-oauth] revocation at the provider failed for "${providerRef}" (purging locally anyway): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      return vault.delete(ref);
    });
  }

  return {
    subjectKey,

    forget,

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

    async startAuthorization(providerRef: string, subject: OeOauthSubject, options: { readonly expiresInMs?: number }): Promise<{ url: string }> {
      const client = await ensureDcrClient(providerRef);
      const redirectUri = redirectUriOf();
      if (!redirectUri) throw new Error(`connection "${providerRef}": OE_PUBLIC_BASE_URL is unset — cannot build a redirect_uri.`);
      const pkce = newPkce();
      const state = newState();
      const pending: PendingRecord = {
        providerRef,
        subject,
        pkceVerifier: pkce.verifier,
        tokenEndpoint: client.tokenEndpoint,
        clientId: client.clientId,
        resource: client.resource,
        redirectUri,
        ...(client.scopes ? { scopes: client.scopes } : {}),
        createdAt: now(),
        expiresAt: now() + (options.expiresInMs ?? pendingTtl),
      };
      await vault.write(pendRef(state), JSON.stringify(pending), { provider: providerRef });
      const url = buildAuthorizationUrl({
        authorizationEndpoint: client.authorizationEndpoint,
        clientId: client.clientId,
        redirectUri,
        state,
        codeChallenge: pkce.challenge,
        resource: client.resource,
        ...(client.scopes ? { scopes: client.scopes } : {}),
      });
      return { url };
    },

    async completeAuthorization(state: string, code: string): Promise<{ providerRef: string }> {
      const pending = await readJson<PendingRecord>(pendRef(state));
      if (!pending) throw new Error("unknown or expired authorization state");
      if (pending.consumed) throw new Error("authorization state already used");
      if (now() > pending.expiresAt) throw new Error("authorization state expired");
      const tok = await exchangeCode(
        pending.tokenEndpoint,
        { code, verifier: pending.pkceVerifier, clientId: pending.clientId, redirectUri: pending.redirectUri, resource: pending.resource },
        doFetch,
      );
      await storeToken(pending.providerRef, pending.subject, tok);
      await vault.write(pendRef(state), JSON.stringify({ ...pending, consumed: true, pkceVerifier: "" }), { provider: pending.providerRef });
      return { providerRef: pending.providerRef };
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

        const claimId = newClaimId();
        const won = await vault.claim(ref, claimId, now(), CLAIM_LEASE_TTL_MS);
        if (won) {
          try {
            const client = await ensureDcrClient(providerRef);
            let tok: OAuthTokenResponse;
            try {
              tok = await refreshToken(
                client.tokenEndpoint,
                { refreshToken: rec.refreshToken, clientId: client.clientId, resource: client.resource, ...(client.scopes ? { scopes: client.scopes } : {}) },
                doFetch,
              );
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
