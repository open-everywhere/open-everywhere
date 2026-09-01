import {
  defineInteractiveAuthorization,
  type ConnectionAuthProvider,
  type ConnectionAuthResolver,
  type InteractiveAuthorizationDefinition,
  type JsonValue,
  type TokenResult,
} from "eve/connections";
import type { SessionContext } from "eve/context";
import { once, type ApprovalStatus } from "eve/tools/approval";
import { connectorToolPermissionKind } from "../approvals/session-grant.js";
import { getOperationalStore } from "../operational/provider.js";
import { routineGrantKeyStamped } from "../routines/routine.js";
import type { ApprovalPolicy } from "eve/tools/approval";
import {
  assertConnectorGranted,
  boundConnectorCredential,
  surfaceContextFromAuth,
} from "../access/connector-scope.js";
import { vercelConnectorOf } from "../access/connector-credentials.js";
import { assertCredentialEndpointHostAllowed } from "../access/credential-endpoints.js";
import { classifyConnectorOpTier, isConnectorOpTool, parseQualifiedToolName } from "../access/consequence.js";
import { effectiveConnectorOpTier, joinConnectorOpTiers } from "../access/connector-op-gating.js";
import { sharedVaultSubjectFor } from "../access/group-request.js";
import { rawVaultSubject, SHARED_VAULT_SUBJECT_PREFIX } from "../identity/oauth-vault-share.js";
import { connectorOpTieringEnabled, connectorLinkSetVaultEnabled, connectorMemberPlaneEnabled } from "./connector-flags.js";
import {
  memberPlaneRefusalMessage,
  memberPlaneVerdict,
  nonMemberWakeFromAuth,
  personalConnectorWriteVerdict,
  personalWriteRefusalMessage,
  requesterFromAuth,
  type MemberPlaneAuthLike,
} from "../access/member-plane.js";
import { OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED } from "../access/requester-identity.js";
import { OE_CHAT_NONMEMBER_ATTR, untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getSecretVia } from "../access/credentials.js";
import { withDuplicateApprovalGuard } from "../access/approval-dedupe.js";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalId, bindFrom, deploymentOrg, unattendedFrom } from "../identity/binding.js";
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
  readonly directUrl?: string;
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

export async function resolveAppTokenFromCred(
  opts: { readonly connector: string; readonly fallbackSecretRef?: string; readonly fallbackBroker?: string; readonly directUrl?: string },
  cred: import("../access/connector-credentials.js").ResolvedConnectorCredential | null,
  o: unknown,
): Promise<TokenResult> {
  if (!cred) {
    if (opts.fallbackSecretRef) return { token: await getSecretVia(opts.fallbackBroker, opts.fallbackSecretRef) };
    throw new Error(
      `connection "${opts.connector}": no credential bound for this surface and no fallback secret — ` +
        `grant it with connectors: [{ name: "${opts.connector}", credential: "<id>", contentOrigin: … }], ` +
        `or give the connection its own fallback secretRef.`,
    );
  }
  if (opts.directUrl !== undefined) {
    assertCredentialEndpointHostAllowed(cred.endpoints, opts.directUrl, `connection "${opts.connector}" credential "${cred.credential}"`);
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
      `(user-principal credentials resolve in the DM universe — arm connectors.userPrincipal and wire ` +
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

export async function effectiveUserVaultSubject(
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
  const raw = rawVaultSubject(org, platform, workspace, principalId);
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
  opts: { readonly connector: string; readonly fallbackSecretRef?: string; readonly fallbackBroker?: string; readonly directUrl?: string },
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
        if (opts.directUrl !== undefined) {
          assertCredentialEndpointHostAllowed(cred.endpoints, opts.directUrl, `connection "${opts.connector}" credential "${cred.credential}"`);
        }
        const { mode, principalId, platform, workspace, org } = await resolveDmPrincipal(ctx.session.auth);
        if (!principalId) {
          throw new Error(
            `connection "${opts.connector}": cannot mint a per-user token — this surface has no ` +
              `resolvable user identity (principalId). Fail closed.`,
          );
        }
        let memberRequester: string | undefined;
        if (mode !== "dm") {
          if (cred.memberPlane !== true) {
            throw new Error(
              `connection "${opts.connector}": a per-user credential resolved on a non-DM surface ` +
                `(mode "${mode ?? "unresolved"}") — refusing to mint a personal token off a shared seat.`,
            );
          }
          const verdict = memberPlaneVerdict({
            armed: connectorMemberPlaneEnabled(),
            opTiered: connectorOpTieringEnabled(),
            granted: true,
            requester: requesterFromAuth(ctx.session.auth, OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED),
            nonMemberWake: nonMemberWakeFromAuth(ctx.session.auth, OE_CHAT_NONMEMBER_ATTR),
          });
          if (!verdict.admit) {
            await auditMintOutcome(opts.connector, { subject: "user", plane: "member", outcome: "refused", reason: verdict.reason });
            throw new Error(memberPlaneRefusalMessage(opts.connector, verdict.reason));
          }
          memberRequester = verdict.requesterPrincipalId;
        }
        const actorId = memberRequester ?? principalId;
        const connector = vercelConnectorOf(cred);
        if (!connector)
          throw new Error(`connection "${opts.connector}": user-oauth credential has no vercel-connect home`);
        const subjectId = await effectiveUserVaultSubject(opts.connector, org, platform, workspace, actorId);
        try {
          const minted = await mintUser(connector, { subject: { type: "user", id: subjectId } });
          await auditMintOutcome(opts.connector, {
            subject: "user",
            outcome: "ok",
            shared: subjectId.startsWith(SHARED_VAULT_SUBJECT_PREFIX),
            ...(memberRequester === undefined ? {} : { plane: "member", requester: memberRequester }),
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

export function connectorOpApproval(deps: ConnectorOpApprovalDeps = {}): ApprovalPolicy {
  return (ctx): ApprovalStatus | Promise<ApprovalStatus> => {
    if (!isConnectorOpTool(ctx.toolName)) return "not-applicable";
    const tier = effectiveConnectorOpTier(ctx.toolName);
    if (tier === "read") return "not-applicable";
    return decideConnectorWrite(ctx, tier, deps.boundCredential ?? boundConnectorCredential, deps.dmPrincipal ?? resolveDmPrincipal);
  };
}

export interface ConnectorOpApprovalDeps {
  readonly boundCredential?: typeof boundConnectorCredential;
  readonly dmPrincipal?: typeof resolveDmPrincipal;
}

async function decideConnectorWrite(
  ctx: { readonly toolName: string; readonly approvedTools: ReadonlySet<string>; readonly session?: { readonly auth?: unknown } },
  tier: ReturnType<typeof effectiveConnectorOpTier>,
  boundCredential: typeof boundConnectorCredential,
  dmPrincipal: typeof resolveDmPrincipal,
): Promise<ApprovalStatus> {
  const auth = ctx.session?.auth;
  if (auth !== undefined && auth !== null) {
    const sessionAuth = auth as Parameters<typeof boundConnectorCredential>[1];
    const connection = ctx.toolName.split("__")[0] as string;
    const bound = await boundCredential(connection, sessionAuth);
    const memberPlaneBinding = bound?.memberPlane === true;
    const personalCredential = bound?.principal === "user";
    const unreadableSurface: Awaited<ReturnType<typeof resolveDmPrincipal>> = {};
    const surface =
      personalCredential && !memberPlaneBinding ? await dmPrincipal(sessionAuth).catch(() => unreadableSurface) : unreadableSurface;
    const verdict = personalConnectorWriteVerdict({
      memberPlaneBinding,
      personalCredential,
      ...(surface.mode === undefined ? {} : { surfaceMode: surface.mode }),
      ...(surface.principalId === undefined ? {} : { actingPrincipalId: surface.principalId }),
      requester: requesterFromAuth(auth as MemberPlaneAuthLike, OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED),
    });
    if (!verdict.prompt) {
      return { type: "denied", reason: personalWriteRefusalMessage(connection, verdict.reason) };
    }
  }
  if (tier === "destructive") return "user-approval";
  if (ctx.approvedTools.has(ctx.toolName)) return "not-applicable";
  return "user-approval";
}

export function connectorApprovalPolicy(): ApprovalPolicy {
  return withDuplicateApprovalGuard(
    withUnattendedConnectorFence(connectorOpTieringEnabled() ? connectorOpApproval() : once()),
  );
}

export const ASK_UNATTENDED_SENTENCE =
  "An unattended run cannot wait on an approval card; arm the permission on the routine's creation card, or ask a person to do this.";

export const TAINTED_ASK_UNATTENDED_SENTENCE =
  "This turn read external content, so this action needs a person to confirm it — and this run is unattended, so there is nobody to ask. No standing grant lifts that; ask a person to do this, or raise it again in a turn that has not read anything external.";

export function unattendedConnectorRefusalMessage(
  connection: string,
  toolName: string,
  tier: ReturnType<typeof effectiveConnectorOpTier>,
  tainted: boolean,
): string {
  const declaration = !tainted && tier === "write" ? `Declare "tool:${toolName}" on the routine's creation card to lift it. ` : "";
  return (
    `connection "${connection}": the ${tier}-tier op "${toolName}" needs approval and nobody is attending this run. ` +
    `${tainted ? TAINTED_ASK_UNATTENDED_SENTENCE : ASK_UNATTENDED_SENTENCE} ${declaration}` +
    `The op did not run.`
  );
}

export interface UnattendedConnectorFenceDeps {
  readonly surfaceContext?: typeof surfaceContextFromAuth;
  readonly grantExists?: (org: string, grantKey: string, kind: string, nowIso: string) => Promise<boolean>;
  readonly audit?: typeof appendAudit;
  readonly tainted?: () => boolean;
}

async function routineGrantExists(org: string, grantKey: string, kind: string, nowIso: string): Promise<boolean> {
  return (await getOperationalStore().getSessionApproval(org, grantKey, kind, nowIso)) !== null;
}

interface FencedTurnFacts {
  readonly unattended: boolean;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly grantKey?: string;
}

async function fencedTurnFacts(
  auth: import("eve/context").SessionAuth,
  surfaceContext: typeof surfaceContextFromAuth,
): Promise<FencedTurnFacts | null> {
  const ctx = await surfaceContext(auth).catch(() => null);
  if (!ctx) return null;
  const grantKey = routineGrantKeyStamped((auth.current ?? auth.initiator)?.attributes);
  try {
    const binding = bindFrom(ctx);
    const partition = resolvePartition(ctx);
    return {
      unattended: unattendedFrom(binding),
      org: partition.org,
      platform: partition.platform,
      workspace: partition.workspace,
      ...(partition.surface === undefined ? {} : { surface: partition.surface }),
      ...(binding.principalId === undefined ? {} : { principalId: binding.principalId }),
      ...(grantKey === undefined ? {} : { grantKey }),
    };
  } catch {
    return null;
  }
}

async function callAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function call<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function decisionWouldPrompt(decision: ApprovalStatus): boolean {
  if (decision === true || decision === "user-approval") return true;
  return typeof decision === "object" && decision !== null && decision.type === "user-approval";
}

export function withUnattendedConnectorFence(
  policy: ApprovalPolicy,
  deps: UnattendedConnectorFenceDeps = {},
): ApprovalPolicy {
  const surfaceContext = deps.surfaceContext ?? surfaceContextFromAuth;
  const grantExists = deps.grantExists ?? routineGrantExists;
  const audit = deps.audit ?? appendAudit;
  const tainted = deps.tainted ?? untrustedIngestedThisTurn;
  return async (ctx): Promise<ApprovalStatus> => {
    const decision = await policy(ctx);
    if (!isConnectorOpTool(ctx.toolName)) return decision;
    const connection = parseQualifiedToolName(ctx.toolName)?.connection;
    const baseTier = classifyConnectorOpTier(ctx.toolName);
    const seamTier = effectiveConnectorOpTier(ctx.toolName);
    const tier = joinConnectorOpTiers(baseTier, seamTier);
    if (tier === "read") return decision;
    const seamBelowBuiltIn = tier !== seamTier;
    if (!decisionWouldPrompt(decision) && !seamBelowBuiltIn) return decision;
    const loweredRefusal = (): ApprovalStatus => ({
      type: "denied",
      reason: unattendedConnectorRefusalMessage(connection ?? "", ctx.toolName, tier, call(tainted, false)),
    });
    if (connection === undefined || connection.length === 0) return seamBelowBuiltIn ? loweredRefusal() : decision;
    const auth = ctx.session?.auth;
    if (auth === undefined || auth === null) return seamBelowBuiltIn ? loweredRefusal() : decision;
    const facts = await fencedTurnFacts(auth as import("eve/context").SessionAuth, surfaceContext);
    if (facts === null) return seamBelowBuiltIn ? loweredRefusal() : decision;
    if (!facts.unattended) return decision;
    const kind = connectorToolPermissionKind(ctx.toolName);
    const nowIso = new Date().toISOString();
    const poisoned = call(tainted, false);
    const lifted =
      !poisoned &&
      tier === "write" &&
      facts.grantKey !== undefined &&
      (await callAsync(() => grantExists(facts.org, facts.grantKey as string, kind, nowIso), false));
    const where = {
      org: facts.org,
      platform: facts.platform,
      workspace: facts.workspace,
      ...(facts.surface === undefined ? {} : { surface: facts.surface }),
      ...(facts.principalId === undefined ? {} : { principalId: facts.principalId }),
    };
    if (lifted) {
      await callAsync(
        () =>
          audit({
            ...where,
            action: "connector.unattended_lift",
            detail: { connection, op: ctx.toolName, tier, grant: kind, routine: facts.grantKey },
          }),
        undefined,
      );
      return "not-applicable";
    }
    await callAsync(
      () =>
        audit({
          ...where,
          action: "connector.refused",
          detail: {
            connection,
            op: ctx.toolName,
            tier,
            reason: poisoned ? "ask-unattended-tainted" : "ask-unattended",
            grant: kind,
            ...(poisoned ? { tainted: true } : {}),
            ...(facts.grantKey === undefined ? { routine: null } : { routine: facts.grantKey }),
          },
        }),
      undefined,
    );
    return { type: "denied", reason: unattendedConnectorRefusalMessage(connection, ctx.toolName, tier, poisoned) };
  };
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
