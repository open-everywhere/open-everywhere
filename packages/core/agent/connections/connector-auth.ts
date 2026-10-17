import { auditErrorDetail } from "../audit/tool-action.js";
import type { ConnectionAuthProvider, ConnectionAuthResolver, TokenResult } from "eve/connections";
import type { SessionAuth, SessionContext } from "eve/context";
import type { ApprovalStatus } from "eve/tools/approval";
import { connectorToolPermissionKind } from "../approvals/session-grant.js";
import { offerRoutinePermissionCardFor } from "../approvals/routine-permission-offer.js";
import "./connector-replay.js";
import { clearSpentConnectorCards, type ConnectorCardRetentionStore } from "./connector-card-retention.js";
import {
  CONNECTOR_INPUT_PREVIEW_CAP,
  CONNECTOR_OP_CARD_KIND,
  CONNECTOR_REPLAY_ADMISSION_TTL_MS,
  CONNECTOR_REPLAY_INPUT_CAP,
  CONNECTOR_REPLAY_INPUT_KEY,
  connectorCardContext,
  connectorOpApprovalKind,
  connectorCardCall,
  connectorReplayAdmissionKey,
  deliverSignInCard,
  mentionsConnectorReplay,
  offerConnectorOpCard,
  readConnectorReplayCardId,
  storedConnectorCall,
  type ConnectorOpCardOffer,
} from "../approvals/connector-op-offer.js";
import { isWorkSessionChildContext } from "../access/work-session.js";
import { createHash } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { routinePermissionKeyStamped } from "../routines/routine.js";
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
import { connectorOpToolHints } from "./connector-tool-hints.js";
import { personalSurfaceApprovalRefusal } from "./personal-surface-fence.js";
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
  roomVouchedInternalFrom,
  type MemberPlaneAuthLike,
} from "../access/member-plane.js";
import { OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED } from "../access/requester-identity.js";
import { OE_CHAT_NONMEMBER_ATTR, untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getSecretVia } from "../access/credentials.js";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalId, auditSurfaceModeStamp, bindFrom, deploymentOrg, proposingGrantScope, unattendedFrom, type BindableContext } from "../identity/binding.js";
import type { SessionMode } from "../access/resolver.js";
import { appendAudit } from "../audit/audit.js";
import {
  requireUserAuthFlow,
  userAuthFlowProvider,
  userAuthRequiredSignal,
  type ConsentCarriage,
} from "./user-auth-flow.js";
import { randomUUID } from "node:crypto";
import { recordConsentDetour, type ConsentOrigin, type ConsentResumeRecord } from "./consent-resume.js";
import { rememberWorkSignIn, type WorkSignInNote } from "../channels/work-sign-in-note.js";
import { resolveReplyTarget } from "../channels/reply-post.js";
import { currentSessionId } from "../identity/binding.js";
import { routineTestStamped, testRunBlockedMessage } from "../routines/test-run.js";
import { recordBlockedCall, type BlockedCallRecorder } from "../access/test-run-fence.js";
import { noteTestRunBlocked } from "../access/test-run-state.js";
import { delegatedNonMemberWakeThisTurn, delegatedRequesterThisTurn } from "../identity/delegated-binding.js";
import {
  connectorAuthRequiredThisTurn,
  connectorAuthUrlThisTurn,
  markConnectorAuthRequired,
  connectorAuthRequiredError,
  clearConnectorAuthRequired,
  freshGrantConfirmed,
} from "./auth-retry-memo.js";

function requesterForAuthority(auth: MemberPlaneAuthLike | undefined) {
  const delegated = delegatedRequesterThisTurn(undefined);
  if (delegated?.kind === "requester") return { kind: "requester" as const, principalId: delegated.principalId };
  if (delegated?.kind === "unverified") return { kind: "unverified" as const };
  if (delegated?.kind === "none") return { kind: "none" as const };
  return requesterFromAuth(auth, OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED);
}

function nonMemberWakeForAuthority(auth: MemberPlaneAuthLike | undefined): boolean {
  return delegatedNonMemberWakeThisTurn(undefined) ?? nonMemberWakeFromAuth(auth, OE_CHAT_NONMEMBER_ATTR);
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
  options: { readonly expiresInMs?: number; readonly consent?: ConsentCarriage },
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

function needsSignInMessage(connector: string, delivered: boolean, repeat = false, resumes = false): string {
  const where = repeat
    ? "A sign-in card was already offered to that person this turn."
    : delivered
      ? "A sign-in card with a private link went to that person directly."
      : "The sign-in card could not be delivered privately, so ask that person to message the agent directly to connect it.";
  return (
    `needs-sign-in: connection "${connector}" needs the person who asked to connect their own account first. ${where} ` +
    "The op did not run, and nothing waits on the sign-in. Finish this task now: report in one short sentence that the job waits for that sign-in. " +
    (delivered && resumes && !repeat ? "Do not retry. When they connect, the host starts this job again." : "Do not retry.")
  );
}

function personalAuthUrlClause(url: string): string {
  return `Open this personal link to connect it (expires soon): ${url} — complete the sign-in, then ask again. `;
}

function connectorAuthRequiredUserMessage(connector: string, authorizeClause: string): string {
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
): Promise<{ mode?: string; principalId?: string; platform?: string; workspace?: string; surface?: string; org?: string; trust?: string; declaredTrust?: string }> {
  const bindCtx = await surfaceContextFromAuth(auth);
  if (!bindCtx) return {};
  try {
    const b = bindFrom(bindCtx);
    return { mode: b.mode, principalId: actingPrincipalId(b), platform: b.platform, workspace: b.workspace, surface: b.surface, org: resolvePartition(bindCtx).org, trust: b.trust, declaredTrust: b.declaredTrust };
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

async function consentOriginFromAuth(
  ctx: SessionContext,
  actorId: string,
): Promise<ConsentOrigin | undefined> {
  try {
    const bindCtx = await surfaceContextFromAuth(ctx.session.auth);
    if (!bindCtx) return undefined;
    const target = resolveReplyTarget(bindCtx);
    if (!target) return undefined;
    const b = bindFrom(bindCtx);
    const sessionId = currentSessionId(ctx as unknown as import("../identity/binding.js").BindableContext);
    return {
      org: b.org,
      surfaceKey: `${b.platform}/${b.workspace}/${b.surface}`,
      target,
      principalId: actorId,
      ...(sessionId ? { sessionId } : {}),
    };
  } catch {
    return undefined;
  }
}

async function consentCarriageFor(
  connector: string,
  ctx: SessionContext,
  actorId: string,
): Promise<ConsentResumeRecord | undefined> {
  try {
    const origin = await consentOriginFromAuth(ctx, actorId);
    if (!origin) return undefined;
    return await recordConsentDetour({
      connector,
      origin,
      nowMs: Date.now(),
      ttlMs: AUTH_URL_TTL_MS,
      detourId: randomUUID(),
    });
  } catch {
    return undefined;
  }
}

export function userAwareProviderToken(
  opts: { readonly connector: string; readonly fallbackSecretRef?: string; readonly fallbackBroker?: string; readonly directUrl?: string },
  deps: {
    readonly mintUser?: ConnectUserTokenMinter;
    readonly startAuth?: ConnectAuthorizationStarter;
    readonly workChild?: (ctx: SessionContext) => boolean;
    readonly deliverSignIn?: typeof deliverSignInCard;
    readonly rememberSignIn?: (ctx: BindableContext, note: WorkSignInNote) => Promise<boolean>;
  } = {},
): ConnectionAuthResolver {
  const mintUser = deps.mintUser ?? ((ref, params) => requireUserAuthFlow(opts.connector).mintUserToken(ref, params));
  const startAuth =
    deps.startAuth ?? ((ref, params, options) => requireUserAuthFlow(opts.connector).startAuthorization(ref, params, options));
  const isWorkChild = deps.workChild ?? ((c: SessionContext) => isWorkSessionChildContext(c as unknown as BindableContext));
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken(o) {
      if (connectorAuthRequiredThisTurn(opts.connector) && !(await memoSelfHealsUserGrant(opts.connector, ctx.session.auth))) {
        if (isWorkChild(ctx)) throw new Error(needsSignInMessage(opts.connector, false, true));
        throw connectorAuthRequiredError(opts.connector, connectorAuthUrlThisTurn(opts.connector));
      }
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      const cred = await boundConnectorCredential(opts.connector, ctx.session.auth);

      if (cred?.type === "user-oauth") {
        if (opts.directUrl !== undefined) {
          assertCredentialEndpointHostAllowed(cred.endpoints, opts.directUrl, `connection "${opts.connector}" credential "${cred.credential}"`);
        }
        const { mode, principalId, platform, workspace, surface, org, trust, declaredTrust } = await resolveDmPrincipal(ctx.session.auth);
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
            requester: requesterForAuthority(ctx.session.auth),
            nonMemberWake: nonMemberWakeForAuthority(ctx.session.auth),
            roomVouchedInternal: roomVouchedInternalFrom(declaredTrust, trust),
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
            ...(authRequired ? {} : { message: auditErrorDetail(e).error }),
          });
          if (authRequired) {
            let url: string | undefined;
            let consent: ConsentResumeRecord | undefined;
            try {
              consent = await consentCarriageFor(opts.connector, ctx, actorId);
              url = (
                await startAuth(
                  connector,
                  { subject: { type: "user", id: subjectId } },
                  { expiresInMs: AUTH_URL_TTL_MS, ...(consent ? { consent } : {}) },
                )
              ).url;
            } catch {
            }
            if (isWorkChild(ctx)) {
              const sameConversation = mode === "dm" && memberRequester === undefined;
              const resumes = consent?.detourId !== undefined;
              const delivered =
                url !== undefined &&
                (await (deps.deliverSignIn ?? deliverSignInCard)({
                  org: org ?? deploymentOrg(),
                  platform: platform ?? "unknown",
                  workspace: workspace ?? "unknown",
                  ...(surface === undefined ? {} : { surface }),
                  recipientId: actorId,
                  connector: opts.connector,
                  url,
                  fromContainer: surface === undefined ? `${platform ?? "unknown"}/${workspace ?? "unknown"}` : `${platform ?? "unknown"}/${workspace ?? "unknown"}/${surface}`,
                  sameConversation,
                  resumes,
                }));
              await (deps.rememberSignIn ?? rememberWorkSignIn)(ctx as unknown as BindableContext, {
                connector: opts.connector,
                delivered,
                sameConversation,
                ...(consent?.detourId !== undefined ? { detourId: consent.detourId, principalId: consent.origin.principalId, surfaceKey: consent.origin.surfaceKey } : {}),
              });
              markConnectorAuthRequired(opts.connector);
              throw new Error(needsSignInMessage(opts.connector, delivered, false, resumes));
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
  return async (ctx): Promise<ApprovalStatus> => {
    if (!isConnectorOpTool(ctx.toolName)) return "not-applicable";
    const hints = await (deps.toolHints ?? connectorOpToolHints)(ctx.toolName);
    const tier = effectiveConnectorOpTier(ctx.toolName, undefined, hints);
    if (tier === "read") return "not-applicable";
    return decideConnectorWrite(ctx, tier, deps.boundCredential ?? boundConnectorCredential, deps.dmPrincipal ?? resolveDmPrincipal);
  };
}

export interface ConnectorOpApprovalDeps {
  readonly boundCredential?: typeof boundConnectorCredential;
  readonly dmPrincipal?: typeof resolveDmPrincipal;
  readonly toolHints?: typeof connectorOpToolHints;
}

export function unresolvableConnectionRefusalMessage(toolName: string): string {
  return (
    `the tool "${toolName}" does not name a connection this plane can resolve. ` +
    `A name in a reserved namespace belongs to the credential-grant plane, not to the connector plane. ` +
    `The op did not run.`
  );
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
    const connection = parseQualifiedToolName(ctx.toolName)?.connection;
    if (connection === undefined) {
      return { type: "denied", reason: unresolvableConnectionRefusalMessage(ctx.toolName) };
    }
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
      requester: requesterForAuthority(auth as MemberPlaneAuthLike),
    });
    if (!verdict.prompt) {
      return { type: "denied", reason: personalWriteRefusalMessage(connection, verdict.reason) };
    }
  }
  if (tier === "destructive") return "user-approval";
  if (ctx.approvedTools.has(ctx.toolName)) return "not-applicable";
  return "user-approval";
}

export function connectorApprovalPolicy(deps: OeConnectorCardDeps = {}): ApprovalPolicy {
  const tiered = connectorOpApproval();
  const carded = withOeConnectorCard(
    withUnattendedConnectorFence((ctx) => (connectorOpTieringEnabled() ? tiered : blanketConnectorApproval)(ctx)),
    deps,
  );
  return async (ctx) => {
    const refusal = await personalSurfaceApprovalRefusal(ctx.toolName, ctx.session?.auth as SessionAuth | undefined);
    if (refusal !== undefined) return { type: "denied", reason: refusal };
    return carded(ctx);
  };
}

const blanketConnectorApproval: ApprovalPolicy = () => "user-approval";

export interface OeConnectorCardDeps {
  readonly store?: Pick<ReturnType<typeof getOperationalStore>, "getSessionApproval" | "markEventSeen" | "hasEventSeen" | "getPendingAction"> & ConnectorCardRetentionStore;
  readonly offer?: typeof offerConnectorOpCard;
  readonly grantScope?: (ctx: Parameters<ApprovalPolicy>[0]) => ConnectorGrantScope | undefined | Promise<ConnectorGrantScope | undefined>;
  readonly tainted?: () => boolean;
  readonly credentialOf?: (connection: string, auth: unknown) => Promise<ConnectorOpCardOffer["credential"]>;
  readonly toolHints?: typeof connectorOpToolHints;
}

async function connectorCredentialPlane(connection: string, auth: unknown): Promise<ConnectorOpCardOffer["credential"]> {
  if (auth === undefined || auth === null) return undefined;
  const bound = await boundConnectorCredential(connection, auth as Parameters<typeof boundConnectorCredential>[1]);
  return bound?.principal === "user" || bound?.memberPlane === true ? "personal" : "domain";
}

export type ConnectorGrantScope = NonNullable<ReturnType<typeof proposingGrantScope>>;

async function liveConnectorGrantScope(ctx: Parameters<ApprovalPolicy>[0]): Promise<ConnectorGrantScope | undefined> {
  const auth = ctx.session?.auth;
  if (auth === undefined || auth === null) return undefined;
  const surface = await surfaceContextFromAuth(auth as import("eve/context").SessionAuth).catch(() => null);
  if (surface === null) return undefined;
  return proposingGrantScope(connectorCardContext(surface, ctx.session));
}

function connectorInputJson(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, (_k, v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))) : v,
    );
  } catch {
    return "(the input could not be rendered)";
  }
}

function connectorInputPreview(input: unknown): string {
  const text = connectorInputJson(input);
  return text.length > CONNECTOR_INPUT_PREVIEW_CAP ? `${text.slice(0, CONNECTOR_INPUT_PREVIEW_CAP)}…` : text;
}

function connectorInputDigest(input: unknown): string {
  return createHash("sha256").update(connectorInputJson(input)).digest("hex").slice(0, 32);
}

function connectorReplayInput(input: unknown): Record<string, unknown> | undefined {
  const text = connectorInputJson(input);
  if (text.length > CONNECTOR_REPLAY_INPUT_CAP) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function connectorOpCardedMessage(connection: string, toolName: string, where: string, pendingId: string, replayable: boolean): string {
  const op = toolName.startsWith(`${connection}__`) ? toolName.slice(connection.length + 2) : toolName;
  const after = replayable
    ? `When a member approves it, replay the approved call by its card id: call \`connection_execute\` with \`connection\` "${connection}", \`tool\` "${op}" and \`input\` {"${CONNECTOR_REPLAY_INPUT_KEY}":"${pendingId}"}. The host then runs the exact input stored on the card. Do not rebuild the input.`
    : "When a member approves it, call the op again with the same input.";
  return (
    `connection "${connection}": the op "${toolName}" needs a member's approval, so an approval card is posted ${where} (pending ${pendingId}). ` +
    `The op did NOT run, and nothing waits on the card. Report that the op waits for approval. ${after}`
  );
}

async function decideConnectorReplay(
  policy: ApprovalPolicy,
  ctx: Parameters<ApprovalPolicy>[0],
  cardId: string | undefined,
  deps: OeConnectorCardDeps,
): Promise<ApprovalStatus> {
  const connection = parseQualifiedToolName(ctx.toolName)?.connection ?? "";
  const deny = (why: string): ApprovalStatus => ({
    type: "denied",
    reason: `connection "${connection}": the replay of an approved card for "${ctx.toolName}" was refused, because ${why}. Nothing ran.`,
  });
  if (cardId === undefined) return deny(`the input holds "${CONNECTOR_REPLAY_INPUT_KEY}" but is not a replay: it must be the only key, and its value must be a card id`);
  if (typeof ctx.callId !== "string" || ctx.callId.length === 0) return deny("this call has no call id to bind the replay to");
  let scope: ConnectorGrantScope | undefined;
  try {
    scope = await (deps.grantScope ?? liveConnectorGrantScope)(ctx);
  } catch {
    scope = undefined;
  }
  if (scope === undefined) return deny("this call names no conversation the card could belong to");
  const org = deploymentOrg();
  const store = deps.store ?? getOperationalStore();
  const row = await callAsync(() => store.getPendingAction(org, cardId), null);
  if (row === null || row.kind !== CONNECTOR_OP_CARD_KIND) return deny(`no connector approval card has the id ${cardId}`);
  const call = connectorCardCall(row.argsJson);
  if (call === undefined) return deny(`card ${cardId} stores no input to replay; call the op again with the exact input on the card`);
  if (call.tool !== ctx.toolName) return deny(`card ${cardId} approves another op`);
  if (call.sessionKey !== scope.key) return deny(`card ${cardId} belongs to another conversation`);
  if (row.status !== "approved") return deny(`card ${cardId} is ${row.status}, not approved`);
  if (call.inputCleared) {
    return deny(
      `card ${cardId}'s one approved call was already used, or its approval lapsed, so the card no longer stores its input. ` +
        "Do not replay this card again. If that call failed and the op is still needed, call the op with its full input to ask for a new approval",
    );
  }
  const stored = storedConnectorCall(row.argsJson);
  if (stored === undefined) return deny(`card ${cardId} stores no input to replay; call the op again with the exact input on the card`);
  if (connectorOpApprovalKind(stored.tool, connectorInputDigest(stored.input)) !== stored.memoKind) return deny(`card ${cardId} does not match its own approval`);
  const decision = await policy({ ...ctx, toolInput: stored.input });
  if (typeof decision === "object" && decision !== null && (decision as { type?: unknown }).type === "denied") return decision;
  const nowIso = new Date().toISOString();
  const spend = await spendOneCallApproval(store, org, stored.sessionKey, stored.memoKind, ctx.callId, nowIso);
  if (spend === "absent") return deny(`card ${cardId}'s one-call approval has expired or was revoked`);
  if (spend === "taken") {
    return deny(
      `card ${cardId}'s one-call approval was already taken by another call. ` +
        "That call may still be running, may have stopped before it ran, or may already have run, so check whether the write happened before you act. " +
        "Do not replay this card again. If the write did not happen and the op is still needed, call the op with its full input to ask for a new approval",
    );
  }
  const admitted = await callAsync(
    () => store.markEventSeen(org, connectorReplayAdmissionKey(cardId, ctx.callId as string), nowIso, CONNECTOR_REPLAY_ADMISSION_TTL_MS),
    false,
  );
  if (!admitted && !(await callAsync(() => store.hasEventSeen(org, connectorReplayAdmissionKey(cardId, ctx.callId as string), nowIso, CONNECTOR_REPLAY_ADMISSION_TTL_MS), false))) {
    return deny("the replay could not be recorded");
  }
  return "not-applicable";
}

async function spendOneCallApproval(
  store: NonNullable<OeConnectorCardDeps["store"]>,
  org: string,
  sessionKey: string,
  memoKind: string,
  callId: unknown,
  nowIso: string,
): Promise<"spent" | "absent" | "taken"> {
  const memo = await callAsync(() => store.getSessionApproval(org, sessionKey, memoKind, nowIso), null);
  if (memo === null) return "absent";
  const ttlMs = Math.max(1, Date.parse(memo.expiresAt) - Date.now());
  const spendKey = `connector-op-spent:${sessionKey}:${memoKind}:${memo.createdAt}`;
  const callKey = typeof callId === "string" && callId.length > 0 ? `${spendKey}:call:${callId}` : undefined;
  if (callKey !== undefined && (await callAsync(() => store.hasEventSeen(org, callKey, nowIso, ttlMs), false))) return "spent";
  const spent = await callAsync(() => store.markEventSeen(org, spendKey, nowIso, ttlMs), false);
  if (spent && callKey !== undefined) await callAsync(() => store.markEventSeen(org, callKey, nowIso, ttlMs), false);
  return spent ? "spent" : "taken";
}

export function withOeConnectorCard(policy: ApprovalPolicy, deps: OeConnectorCardDeps = {}): ApprovalPolicy {
  return async (ctx): Promise<ApprovalStatus> => {
    if (mentionsConnectorReplay(ctx.toolInput)) return decideConnectorReplay(policy, ctx, readConnectorReplayCardId(ctx.toolInput), deps);
    const decision = await policy(ctx);
    if (!decisionWouldPrompt(decision)) return decision;
    const connection = parseQualifiedToolName(ctx.toolName)?.connection;
    if (!isConnectorOpTool(ctx.toolName) || connection === undefined || connection.length === 0) {
      return { type: "denied", reason: unresolvableConnectionRefusalMessage(ctx.toolName) };
    }
    const deny = (why: string): ApprovalStatus => ({
      type: "denied",
      reason: `connection "${connection}": the op "${ctx.toolName}" needs a member's approval, and ${why}. The op did not run.`,
    });
    let scope: ConnectorGrantScope | undefined;
    try {
      scope = await (deps.grantScope ?? liveConnectorGrantScope)(ctx);
    } catch {
      scope = undefined;
    }
    if (scope === undefined) return deny("this call names no conversation an approval could be kept for");
    const sessionKey = scope.key;
    const effectiveTier = effectiveConnectorOpTier(ctx.toolName, undefined, await (deps.toolHints ?? connectorOpToolHints)(ctx.toolName));
    const opTier: ConnectorOpCardOffer["opTier"] = effectiveTier === "read" ? undefined : effectiveTier;
    const grain: ConnectorOpCardOffer["grain"] = connectorOpTieringEnabled() && effectiveTier === "destructive" ? "destructive" : "call";
    const memoKind = connectorOpApprovalKind(ctx.toolName, connectorInputDigest(ctx.toolInput));
    const org = deploymentOrg();
    const store = deps.store ?? getOperationalStore();
    const nowIso = new Date().toISOString();
    if ((await spendOneCallApproval(store, org, sessionKey, memoKind, ctx.callId, nowIso)) === "spent") {
      await clearSpentConnectorCards(store, org, sessionKey, memoKind, nowIso);
      return "not-applicable";
    }
    const replayInput = connectorReplayInput(ctx.toolInput);
    const credential = await callAsync(() => (deps.credentialOf ?? connectorCredentialPlane)(connection, ctx.session?.auth), undefined);
    const offered = await (deps.offer ?? offerConnectorOpCard)({
      org,
      tool: ctx.toolName,
      connection,
      grain,
      ...(opTier === undefined ? {} : { opTier }),
      sessionKey,
      memoKind,
      inputPreview: connectorInputPreview(ctx.toolInput),
      ...(replayInput === undefined ? {} : { input: replayInput }),
      auth: ctx.session?.auth,
      session: ctx.session,
      tainted: taintedOrPoisoned(deps.tainted ?? untrustedIngestedThisTurn),
      ...(credential === undefined ? {} : { credential }),
    });
    if (offered.outcome === "approved") return "not-applicable";
    if (offered.outcome === "refused") return deny(offered.reason);
    return { type: "denied", reason: connectorOpCardedMessage(connection, ctx.toolName, offered.where, offered.pendingId, replayInput !== undefined) };
  };
}

export const ASK_UNATTENDED_SENTENCE =
  "An unattended run cannot wait on an approval card; arm the permission on the routine's creation card, or ask a person to do this.";

export const TAINTED_ASK_UNATTENDED_SENTENCE =
  "This turn read external content, so this action needs a person to confirm it — and this run is unattended, so there is nobody to ask. No standing grant lifts that; ask a person to do this, or raise it again in a turn that has not read anything external.";

export const TAINTED_CONNECTOR_ORIGIN_ADVICE =
  "A fire has no other turn. A connector read marks every fire untrusted while its grant declares `contentOrigin: \"external\"` or declares nothing. Only `contentOrigin: \"internal\"` changes that, and it asserts that org members author everything the connection returns. Do not declare it to unblock a routine.";

export function unattendedConnectorRefusalMessage(
  connection: string,
  toolName: string,
  tier: ReturnType<typeof effectiveConnectorOpTier>,
  tainted: boolean,
): string {
  const declaration = !tainted && tier === "write" ? `Declare "tool:${toolName}" on the routine's creation card to lift it. ` : "";
  const origin = tainted ? `${TAINTED_CONNECTOR_ORIGIN_ADVICE} ` : "";
  return (
    `connection "${connection}": the ${tier}-tier op "${toolName}" needs approval and nobody is attending this run. ` +
    `${tainted ? TAINTED_ASK_UNATTENDED_SENTENCE : ASK_UNATTENDED_SENTENCE} ${declaration}${origin}` +
    `The op did not run.`
  );
}

export interface UnattendedConnectorFenceDeps {
  readonly surfaceContext?: typeof surfaceContextFromAuth;
  readonly grantExists?: (org: string, grantKey: string, kind: string, nowIso: string) => Promise<boolean>;
  readonly audit?: typeof appendAudit;
  readonly tainted?: () => boolean;
  readonly toolHints?: typeof connectorOpToolHints;
  readonly recordTestBlocked?: BlockedCallRecorder;
}

async function routinePermissionExists(org: string, grantKey: string, kind: string, nowIso: string): Promise<boolean> {
  return (await getOperationalStore().getSessionApproval(org, grantKey, kind, nowIso)) !== null;
}

interface FencedTurnFacts {
  readonly unattended: boolean;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly surfaceKey: string;
  readonly surfaceMode?: SessionMode;
  readonly principalId?: string;
  readonly grantKey?: string;
}

async function fencedTurnFacts(
  auth: import("eve/context").SessionAuth,
  surfaceContext: typeof surfaceContextFromAuth,
): Promise<FencedTurnFacts | null> {
  const ctx = await surfaceContext(auth).catch(() => null);
  if (!ctx) return null;
  const grantKey = routinePermissionKeyStamped((auth.current ?? auth.initiator)?.attributes);
  try {
    const binding = bindFrom(ctx);
    const partition = resolvePartition(ctx);
    return {
      unattended: unattendedFrom(binding),
      org: partition.org,
      platform: partition.platform,
      workspace: partition.workspace,
      surfaceKey: partition.surfaceKey,
      ...(partition.surface === undefined ? {} : { surface: partition.surface }),
      ...auditSurfaceModeStamp(binding),
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

function taintedOrPoisoned(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return true;
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
  const permissionExists = deps.grantExists ?? routinePermissionExists;
  const audit = deps.audit ?? appendAudit;
  const tainted = deps.tainted ?? untrustedIngestedThisTurn;
  return async (ctx): Promise<ApprovalStatus> => {
    const decision = await policy(ctx);
    if (!isConnectorOpTool(ctx.toolName)) return decision;
    const connection = parseQualifiedToolName(ctx.toolName)?.connection;
    const hints = await (deps.toolHints ?? connectorOpToolHints)(ctx.toolName);
    const baseTier = classifyConnectorOpTier(ctx.toolName, hints);
    const seamTier = effectiveConnectorOpTier(ctx.toolName, undefined, hints);
    const tier = joinConnectorOpTiers(baseTier, seamTier);
    if (tier === "read") return decision;
    const testRun = routineTestStamped((ctx.session?.auth?.current ?? ctx.session?.auth?.initiator)?.attributes);
    if (testRun !== null) {
      noteTestRunBlocked();
      await callAsync(() => (deps.recordTestBlocked ?? recordBlockedCall)(testRun, ctx.toolName, ctx.toolInput), undefined);
      return { type: "denied", reason: testRunBlockedMessage(ctx.toolName) };
    }
    const seamBelowBuiltIn = tier !== seamTier;
    if (!decisionWouldPrompt(decision) && !seamBelowBuiltIn) return decision;
    const poisoned = taintedOrPoisoned(tainted);
    const loweredRefusal = (): ApprovalStatus => ({
      type: "denied",
      reason: unattendedConnectorRefusalMessage(connection ?? "", ctx.toolName, tier, poisoned),
    });
    if (connection === undefined || connection.length === 0) return seamBelowBuiltIn ? loweredRefusal() : decision;
    const auth = ctx.session?.auth;
    if (auth === undefined || auth === null) return seamBelowBuiltIn ? loweredRefusal() : decision;
    const facts = await fencedTurnFacts(auth as import("eve/context").SessionAuth, surfaceContext);
    if (facts === null) return seamBelowBuiltIn ? loweredRefusal() : decision;
    if (!facts.unattended) return decision;
    const kind = connectorToolPermissionKind(ctx.toolName);
    const nowIso = new Date().toISOString();
    const lifted =
      !poisoned &&
      tier === "write" &&
      facts.grantKey !== undefined &&
      (await callAsync(() => permissionExists(facts.org, facts.grantKey as string, kind, nowIso), false));
    const where = {
      org: facts.org,
      platform: facts.platform,
      workspace: facts.workspace,
      ...(facts.surface === undefined ? {} : { surface: facts.surface }),
      ...(facts.surfaceMode === undefined ? {} : { surfaceMode: facts.surfaceMode }),
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
    const routineKey = facts.grantKey;
    const requestedBy = facts.principalId;
    const card =
      tier === "write" && routineKey !== undefined && requestedBy !== undefined
        ? await offerRoutinePermissionCardFor({
            org: facts.org,
            declaration: `tool:${ctx.toolName}`,
            grantKind: connectorToolPermissionKind(ctx.toolName),
            grantKey: routineKey,
            scopeKey: facts.surfaceKey,
            requestedBy,
            tainted: poisoned,
            waitBudgetMs: 0,
          })
        : { clause: "" };
    return { type: "denied", reason: unattendedConnectorRefusalMessage(connection, ctx.toolName, tier, poisoned) + card.clause };
  };
}

