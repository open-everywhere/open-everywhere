import {
  defineInteractiveAuthorization,
  type ConnectionAuthProvider,
  type ConnectionAuthResolver,
  type InteractiveAuthorizationDefinition,
  type JsonValue,
  type TokenResult,
} from "eve/connections";
import type { SessionContext } from "eve/context";
import { once, type Approval, type ApprovalStatus } from "eve/tools/approval";
import {
  assertConnectorGranted,
  boundConnectorCredential,
  surfaceContextFromAuth,
} from "../access/connector-scope.js";
import { classifyConnectorOp, isConnectorOpTool } from "../access/consequence.js";
import { connectorOpTieringEnabled } from "./connector-flags.js";
import { getSecretVia } from "../access/credentials.js";
import { bindFrom, deploymentOrg } from "../identity/binding.js";
import { appendAudit } from "../audit/audit.js";
import {
  connectorAuthRequiredThisTurn,
  connectorAuthUrlThisTurn,
  markConnectorAuthRequired,
  connectorAuthRequiredError,
} from "./auth-retry-memo.js";

const connectAuthById = new Map<string, Promise<ConnectionAuthProvider>>();
function connectAuthFor(connector: string, vercelConnector: string): Promise<ConnectionAuthProvider> {
  let p = connectAuthById.get(vercelConnector);
  if (!p) {
    p = (async () => {
      try {
        const spec = "@vercel/connect" + "/eve";
        const mod = (await import(spec)) as { connect(o: { connector: string }): ConnectionAuthProvider };
        return mod.connect({ connector: vercelConnector });
      } catch {
        throw new Error(
          `connection "${connector}": service OAuth needs @vercel/connect (LIVE-ONLY). ` +
            `Install it + link a Vercel project, or use a fixed-key credential.`,
        );
      }
    })();
    connectAuthById.set(vercelConnector, p);
  }
  return p;
}

export function appStaticToken(opts: {
  readonly connector: string;
  readonly secretRef: string;
  readonly broker: string;
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken() {
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      return { token: await getSecretVia(opts.broker, opts.secretRef) };
    },
  });
}

export function appConnectToken(opts: {
  readonly connector: string;
  readonly vercelConnector: string;
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken(o) {
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      const base = await connectAuthFor(opts.connector, opts.vercelConnector);
      return (base as { getToken(o: unknown): unknown }).getToken(o) as Promise<TokenResult>;
    },
  });
}

export function appProviderToken(opts: {
  readonly connector: string;
  readonly fallbackSecretRef?: string;
  readonly fallbackBroker?: string;
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken(o) {
      if (connectorAuthRequiredThisTurn(opts.connector)) throw connectorAuthRequiredError(opts.connector);
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      const cred = await boundConnectorCredential(opts.connector, ctx.session.auth);
      return resolveAppTokenFromCred(opts, cred, o);
    },
  });
}

async function resolveAppTokenFromCred(
  opts: { readonly connector: string; readonly fallbackSecretRef?: string; readonly fallbackBroker?: string },
  cred: import("../access/providers.js").ResolvedConnectorCredential | null,
  o: unknown,
): Promise<TokenResult> {
  if (!cred) {
    if (opts.fallbackSecretRef) return { token: await getSecretVia(opts.fallbackBroker, opts.fallbackSecretRef) };
    throw new Error(
      `connection "${opts.connector}": no provider credential bound for this surface and no ` +
        `fallback secret — grant it via a provider (bundle.providers) or a raw connection secretRef.`,
    );
  }
  if (cred.type === "api-key") {
    if (!cred.secretRef) throw new Error(`connection "${opts.connector}": api-key credential has no secretRef`);
    return { token: await getSecretVia(cred.broker, cred.secretRef) };
  }
  if (cred.type === "service-oauth") {
    if (!cred.vercelConnector)
      throw new Error(`connection "${opts.connector}": service-oauth credential has no vercelConnector`);
    const base = await connectAuthFor(opts.connector, cred.vercelConnector);
    return (base as { getToken(o: unknown): unknown }).getToken(o) as Promise<TokenResult>;
  }
  throw new Error(
    `connection "${opts.connector}": credential type "${cred.type}" is not valid on an app connection ` +
      `(user-principal credentials resolve in the DM universe — arm OE_CONNECTOR_USER_PRINCIPAL and wire ` +
      `userAwareProviderToken to mint a per-user token).`,
  );
}

export interface ConnectUserTokenParams {
  readonly subject: { readonly type: "user"; readonly id: string; readonly issuer?: string };
  readonly scopes?: readonly string[];
  readonly resources?: readonly string[];
}

export type ConnectUserTokenMinter = (vercelConnector: string, params: ConnectUserTokenParams) => Promise<TokenResult>;

export type ConnectAuthorizationStarter = (
  vercelConnector: string,
  params: { readonly subject: { readonly type: "user"; readonly id: string } },
  options: { readonly expiresInMs?: number },
) => Promise<{ url: string }>;

export const AUTH_URL_TTL_MS = 15 * 60 * 1000;

type ConnectBaseModule = {
  getTokenResponse(connector: string, params: unknown): Promise<{ token: string }>;
  startAuthorization(connector: string, params: unknown, options?: unknown): Promise<{ url: string }>;
};
let connectBase: Promise<ConnectBaseModule> | undefined;
function loadConnectBase(): Promise<ConnectBaseModule> {
  if (!connectBase) {
    connectBase = (async () => {
      try {
        const spec = "@vercel/" + "connect";
        return (await import(spec)) as ConnectBaseModule;
      } catch {
        throw new Error(
          "per-user connector credential needs @vercel/connect (LIVE-ONLY). Install it + link a Vercel project.",
        );
      }
    })();
  }
  return connectBase;
}

async function oidcEnvironmentClaim(): Promise<string> {
  try {
    const mod = (await import("@vercel/" + "oidc")) as { getVercelOidcToken?: () => Promise<string> };
    const tok = mod.getVercelOidcToken ? await mod.getVercelOidcToken() : process.env.VERCEL_OIDC_TOKEN;
    if (!tok) return "no-token";
    const payload = JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64url").toString()) as { environment?: string };
    return typeof payload.environment === "string" ? payload.environment : "no-claim";
  } catch {
    return "decode-failed";
  }
}

async function auditMintOutcome(connector: string, detail: Readonly<Record<string, unknown>>): Promise<void> {
  await appendAudit({
    org: deploymentOrg(),
    platform: "connector",
    workspace: "connector",
    action: "connector.mint",
    detail: { connector, oidcEnv: await oidcEnvironmentClaim(), ...detail },
  });
}

const defaultUserMinter: ConnectUserTokenMinter = async (vercelConnector, params) => {
  const mod = await loadConnectBase();
  const resp = await mod.getTokenResponse(vercelConnector, {
    subject: {
      type: "user",
      id: params.subject.id,
      ...(params.subject.issuer ? { issuer: params.subject.issuer } : {}),
    },
    ...(params.scopes?.length ? { scopes: [...params.scopes] } : {}),
    ...(params.resources?.length ? { resources: [...params.resources] } : {}),
  });
  return { token: resp.token };
};

export const defaultAuthStarter: ConnectAuthorizationStarter = async (vercelConnector, params, options) => {
  const mod = await loadConnectBase();
  const resp = await mod.startAuthorization(
    vercelConnector,
    { subject: { type: "user", id: params.subject.id } },
    { ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}) },
  );
  return { url: resp.url };
};

export type ConnectorAuthSubject =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "app" };

export type ConnectorAuthorizationStarter = (
  vercelConnector: string,
  params: { readonly subject: ConnectorAuthSubject },
  options: { readonly expiresInMs?: number },
) => Promise<{ url: string }>;

export const defaultConnectorAuthStarter: ConnectorAuthorizationStarter = async (vercelConnector, params, options) => {
  const mod = await loadConnectBase();
  const resp = await mod.startAuthorization(
    vercelConnector,
    { subject: params.subject },
    { ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}) },
  );
  return { url: resp.url };
};

function isUserAuthRequired(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return (
    e.name === "UserAuthorizationRequiredError" ||
    (typeof code === "string" && /user_authorization_required/i.test(code)) ||
    /user[_ ]?authorization[_ ]?required/i.test(e.message)
  );
}

export function userAwareProviderToken(
  opts: { readonly connector: string; readonly fallbackSecretRef?: string; readonly fallbackBroker?: string },
  deps: { readonly mintUser?: ConnectUserTokenMinter; readonly startAuth?: ConnectAuthorizationStarter } = {},
): ConnectionAuthResolver {
  const mintUser = deps.mintUser ?? defaultUserMinter;
  const startAuth = deps.startAuth ?? defaultAuthStarter;
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken(o) {
      if (connectorAuthRequiredThisTurn(opts.connector))
        throw connectorAuthRequiredError(opts.connector, connectorAuthUrlThisTurn(opts.connector));
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      const cred = await boundConnectorCredential(opts.connector, ctx.session.auth);

      if (cred?.type === "user-oauth") {
        const bindCtx = await surfaceContextFromAuth(ctx.session.auth);
        let mode: string | undefined;
        let principalId: string | undefined;
        if (bindCtx) {
          try {
            const b = bindFrom(bindCtx);
            mode = b.mode;
            principalId = b.principalId;
          } catch {
          }
        }
        if (mode !== "dm") {
          throw new Error(
            `connection "${opts.connector}": a per-user credential resolved on a non-DM surface ` +
              `(mode "${mode ?? "unresolved"}") — refusing to mint a personal token off a shared seat.`,
          );
        }
        if (!principalId) {
          throw new Error(
            `connection "${opts.connector}": cannot mint a per-user token — this DM surface has no ` +
              `resolvable user identity (principalId). Fail closed.`,
          );
        }
        if (!cred.vercelConnector)
          throw new Error(`connection "${opts.connector}": user-oauth credential has no vercelConnector`);
        try {
          const minted = await mintUser(cred.vercelConnector, { subject: { type: "user", id: principalId } });
          await auditMintOutcome(opts.connector, { subject: "user", outcome: "ok" });
          return minted;
        } catch (e) {
          await auditMintOutcome(opts.connector, {
            subject: "user",
            outcome: isUserAuthRequired(e) ? "auth-required" : "error",
            name: e instanceof Error ? e.name : "unknown",
            ...(isUserAuthRequired(e) ? {} : { message: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) }),
          });
          if (isUserAuthRequired(e)) {
            let url: string | undefined;
            try {
              url = (await startAuth(cred.vercelConnector, { subject: { type: "user", id: principalId } }, { expiresInMs: AUTH_URL_TTL_MS })).url;
            } catch {
            }
            markConnectorAuthRequired(opts.connector, url);
            throw new Error(
              `connection "${opts.connector}": your personal account isn't connected yet. ` +
                (url
                  ? `Open this personal link to connect it (expires soon): ${url} — complete the sign-in, then ask again. `
                  : `Authorize it in your browser (Vercel Connect connector "${cred.vercelConnector}"), then ask again. `) +
                `This connector acts as YOU with YOUR own access — not the shared service account. ` +
                `If they later say they've completed the sign-in, RETRY the operation to re-check — ` +
                `never claim it is still unconnected without a fresh attempt.`,
            );
          }
          throw e;
        }
      }

      return resolveAppTokenFromCred(opts, cred, o);
    },
  });
}

export function connectorOpApproval(): Approval {
  return (ctx): ApprovalStatus => {
    if (!isConnectorOpTool(ctx.toolName)) return "not-applicable";
    if (classifyConnectorOp(ctx.toolName) === "open") return "not-applicable";
    if (ctx.approvedTools.has(ctx.toolName)) return "not-applicable";
    return "user-approval";
  };
}

export function connectorApprovalPolicy(): Approval {
  return connectorOpTieringEnabled() ? connectorOpApproval() : once();
}

export function userInteractiveOAuth<Resume extends JsonValue = JsonValue>(opts: {
  readonly connector: string;
  readonly getToken: InteractiveAuthorizationDefinition<Resume>["getToken"];
  readonly startAuthorization: InteractiveAuthorizationDefinition<Resume>["startAuthorization"];
  readonly completeAuthorization: InteractiveAuthorizationDefinition<Resume>["completeAuthorization"];
  readonly displayName?: string;
  readonly evict?: InteractiveAuthorizationDefinition<Resume>["evict"];
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> =>
    defineInteractiveAuthorization<Resume>({
      displayName: opts.displayName,
      async getToken(o) {
        await assertConnectorGranted(opts.connector, ctx.session.auth);
        return opts.getToken(o);
      },
      startAuthorization: opts.startAuthorization,
      completeAuthorization: opts.completeAuthorization,
      evict: opts.evict,
    });
}
