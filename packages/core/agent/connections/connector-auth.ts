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
import { vercelConnectorOf } from "../access/providers.js";
import { isConnectorOpTool } from "../access/consequence.js";
import { effectiveConnectorOpTier } from "../access/connector-op-gating.js";
import { sharedVaultSubjectFor } from "../access/group-request.js";
import { rawVaultSubject, SHARED_VAULT_SUBJECT_PREFIX } from "../identity/oauth-vault-share.js";
import { connectorOpTieringEnabled, connectorLinkSetVaultEnabled } from "./connector-flags.js";
import { getSecretVia } from "../access/credentials.js";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalId, bindFrom, deploymentOrg } from "../identity/binding.js";
import { appendAudit } from "../audit/audit.js";
import {
  requireUserAuthFlow,
  userAuthFlowProvider,
  userAuthRequiredSignal,
} from "./user-auth-flow.js";
import {
  connectorAuthRequiredThisTurn,
  connectorAuthUrlThisTurn,
  markConnectorAuthRequired,
  connectorAuthRequiredError,
  clearConnectorAuthRequired,
  freshGrantConfirmed,
} from "./auth-retry-memo.js";

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
      return requireUserAuthFlow(opts.connector).mintServiceToken(opts.vercelConnector, o);
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
    const connector = vercelConnectorOf(cred);
    if (!connector)
      throw new Error(`connection "${opts.connector}": service-oauth credential has no vercel-connect home`);
    return requireUserAuthFlow(opts.connector).mintServiceToken(connector, o);
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

async function auditMintOutcome(connector: string, detail: Readonly<Record<string, unknown>>): Promise<void> {
  const flow = userAuthFlowProvider();
  const oidcEnv = flow ? await flow.environmentClaim() : "unregistered";
  await appendAudit({
    org: deploymentOrg(),
    platform: "connector",
    workspace: "connector",
    action: "connector.mint",
    detail: { connector, oidcEnv, ...detail },
  });
}

export type ConnectorAuthSubject =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "app" };

export type ConnectorAuthorizationStarter = (
  vercelConnector: string,
  params: { readonly subject: ConnectorAuthSubject },
  options: { readonly expiresInMs?: number },
) => Promise<{ url: string }>;

export const defaultConnectorAuthStarter: ConnectorAuthorizationStarter = (vercelConnector, params, options) =>
  requireUserAuthFlow(vercelConnector).startAuthorization(vercelConnector, params, options);

export function personalAuthUrlClause(url: string): string {
  return `Open this personal link to connect it (expires soon): ${url} — complete the sign-in, then ask again. `;
}

export function connectorAuthRequiredUserMessage(connector: string, authorizeClause: string): string {
  return (
    `connection "${connector}": your personal account isn't connected yet. ` +
    authorizeClause +
    `This connector acts as YOU with YOUR own access — not the shared service account. ` +
    `If they later say they've completed the sign-in, RETRY the operation to re-check — ` +
    `never claim it is still unconnected without a fresh attempt.`
  );
}

export async function resolveDmPrincipal(
  auth: import("eve/context").SessionAuth,
): Promise<{ mode?: string; principalId?: string; platform?: string; workspace?: string; org?: string }> {
  const bindCtx = await surfaceContextFromAuth(auth);
  if (!bindCtx) return {};
  try {
    const b = bindFrom(bindCtx);
    return { mode: b.mode, principalId: actingPrincipalId(b), platform: b.platform, workspace: b.workspace, org: resolvePartition(bindCtx).org };
  } catch {
    return {};
  }
}

async function effectiveUserVaultSubject(
  connector: string,
  org: string | undefined,
  platform: string | undefined,
  workspace: string | undefined,
  principalId: string,
): Promise<string> {
  if (!org || !platform) {
    throw new Error(
      `connection "${connector}": cannot key a per-user credential — this DM surface resolved no ` +
        `${!org ? "org" : "platform"}, and a vault subject must be qualified by both. Fail closed.`,
    );
  }
  const raw = rawVaultSubject(org, platform, principalId);
  if (!connectorLinkSetVaultEnabled()) return raw;
  return (await sharedVaultSubjectFor(org, connector, platform, principalId, workspace)) ?? raw;
}

function classifyUserAuthRequired(e: unknown): boolean {
  const flow = userAuthFlowProvider();
  return flow ? flow.isUserAuthRequired(e) : userAuthRequiredSignal(e);
}

async function memoSelfHealsUserGrant(
  connector: string,
  auth: import("eve/context").SessionAuth,
): Promise<boolean> {
  const flow = userAuthFlowProvider();
  if (!flow?.hasFreshGrant) return false;
  const cred = await boundConnectorCredential(connector, auth);
  if (cred?.type !== "user-oauth") return false;
  const providerRef = vercelConnectorOf(cred);
  if (!providerRef) return false;
  const { mode, principalId, platform, workspace, org } = await resolveDmPrincipal(auth);
  if (mode !== "dm" || !principalId || !org || !platform) return false;
  const subjectId = await effectiveUserVaultSubject(connector, org, platform, workspace, principalId);
  const probe = flow.hasFreshGrant.bind(flow);
  if (!(await freshGrantConfirmed(() => probe(providerRef, { type: "user", id: subjectId })))) return false;
  clearConnectorAuthRequired(connector);
  return true;
}

export function userAwareProviderToken(
  opts: { readonly connector: string; readonly fallbackSecretRef?: string; readonly fallbackBroker?: string },
  deps: { readonly mintUser?: ConnectUserTokenMinter; readonly startAuth?: ConnectAuthorizationStarter } = {},
): ConnectionAuthResolver {
  const mintUser = deps.mintUser ?? ((ref, params) => requireUserAuthFlow(opts.connector).mintUserToken(ref, params));
  const startAuth =
    deps.startAuth ?? ((ref, params, options) => requireUserAuthFlow(opts.connector).startAuthorization(ref, params, options));
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken(o) {
      if (connectorAuthRequiredThisTurn(opts.connector) && !(await memoSelfHealsUserGrant(opts.connector, ctx.session.auth)))
        throw connectorAuthRequiredError(opts.connector, connectorAuthUrlThisTurn(opts.connector));
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      const cred = await boundConnectorCredential(opts.connector, ctx.session.auth);

      if (cred?.type === "user-oauth") {
        const { mode, principalId, platform, workspace, org } = await resolveDmPrincipal(ctx.session.auth);
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
        const connector = vercelConnectorOf(cred);
        if (!connector)
          throw new Error(`connection "${opts.connector}": user-oauth credential has no vercel-connect home`);
        const subjectId = await effectiveUserVaultSubject(opts.connector, org, platform, workspace, principalId);
        try {
          const minted = await mintUser(connector, { subject: { type: "user", id: subjectId } });
          await auditMintOutcome(opts.connector, {
            subject: "user",
            outcome: "ok",
            shared: subjectId.startsWith(SHARED_VAULT_SUBJECT_PREFIX),
          });
          return minted;
        } catch (e) {
          const authRequired = classifyUserAuthRequired(e);
          await auditMintOutcome(opts.connector, {
            subject: "user",
            outcome: authRequired ? "auth-required" : "error",
            name: e instanceof Error ? e.name : "unknown",
            ...(authRequired ? {} : { message: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) }),
          });
          if (authRequired) {
            let url: string | undefined;
            try {
              url = (await startAuth(connector, { subject: { type: "user", id: subjectId } }, { expiresInMs: AUTH_URL_TTL_MS })).url;
            } catch {
            }
            markConnectorAuthRequired(opts.connector, url);
            const authorizeClause = url
              ? personalAuthUrlClause(url)
              : `Authorize it in your browser (connector "${connector}"), then ask again. `;
            throw new Error(connectorAuthRequiredUserMessage(opts.connector, authorizeClause));
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
    const tier = effectiveConnectorOpTier(ctx.toolName);
    if (tier === "read") return "not-applicable";
    if (tier === "destructive") return "user-approval";
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
