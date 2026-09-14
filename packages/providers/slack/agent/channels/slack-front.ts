import { POST, type Channel, type HttpRouteDefinition, type RouteHandlerArgs } from "eve/channels";
import { SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER, slackSignature, slackSignatureMatches } from "./slack-signature.js";
import { slackContinuationToken } from "eve/channels/slack";
import { callSlackWebApi } from "./slack-web-api.js";
import {
  auditDmBotAuthorDrop,
  auditDmDriverAdmitted,
  dmDoorAdmitsDriver,
  parseMessageEvent,
  routeMessageEvent,
  liveDeps,
  routeNameDropEvent,
  liveNameDropDeps,
  parseChannelJoinEvent,
  routeChannelJoinEvent,
  liveChannelJoinDeps,
  parseSlackReactionEvent,
  routeReactionEvent,
  liveReactionDeps,
  routeSupervisorEvent,
  liveSupervisorDeps,
  supervisorFifoKey,
  bindableFor,
  bindableForJoin,
  bindableForReaction,
  slackSingleWindowMentionPolicy,
  slackDomainUsesUnifiedWindow,
  slackFrontTenantFenceDeclined,
  slackInteractivityTenantFenceDeclined,
  type SlackEventEnvelope,
  type ParsedMessageEvent,
  type NameDropContextHydrator,
  type RouteOutcome,
} from "./slack-events.js";
import { slackInteractivityTenantIds } from "./slack-tenant-fence.js";
import {
  EventDedupe,
  ThreadFifo,
  getOrCreateDmSeat as liveGetOrCreateDmSeat,
  touchDmSeat as liveTouchDmSeat,
  dmSeatThresholds,
  resolvePartition,
  domainKeyOf,
  isThreadEngaged,
  divertInboundToUnifiedWindow,
  isPrunedDeploymentWakeError,
  markUndeliveredAfterHeal,
  isUndeliveredAfterHeal,
  healPrunedDeploymentStrand,
  mintWakeId,
  slackVendorEventTime,
  spreadVendorTs,
  resolveWakeTrust,
  ambientSupervisorEnabled,
  getConfig,
  getOperationalStore,
  OE_APPROVAL_PREFIX,
  handleApprovalPayload as liveHandleApprovalPayload,
  OE_SETKEY_ACTION_PREFIX,
  OE_SETKEY_MODAL_CALLBACK,
  handleSetKeyClick as liveHandleSetKeyClick,
  handleSetKeyViewSubmission as liveHandleSetKeyViewSubmission,
  OE_CONNECT_ACTION_PREFIX,
  handleConnectClick as liveHandleConnectClick,
  OE_GRANT_ACTION_PREFIX,
  OE_INPUT_CLICK_PREFIX,
  handleGrantCardClick as liveHandleGrantCardClick,
  buildRecord,
  enqueue as enqueueLogRecord,
  flushLogShip,
  type SingleWindowMentionPolicy,
  type DmSeat,
  type SetKeyViewResult,
  stampNonMemberChatAuth,
  externalPolicyIsInert,
  recordWakeTail,
  tailAuthorGrain,
  dmWindowRegistryKey,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  renderWakeMessage,
  slackChannelFactsFor,
  slackAuthorIsMember,
  slackClickerIsGuest,
  slackWakeAuthorFacts,
  slackExternalPolicyForRoom,
  applySlackExternalPolicy,
  stripUnfencedSlackAttachments,
  slackEnterpriseIdFromEnvelope,
  _resetAuthorMemberCache,
} from "./slack-events.js";
import { buildSlackAuth, withForwardedSlackEnvelope, type ForwardedSlackEnvelope } from "./slack-identity.js";
import { holdRouteWork, routeHoldQuiesced, withSlackRouteHold } from "./slack-route-hold.js";
import { persistSlackAttachment, registerSlackAttachment } from "./slack-attachments.js";
import {
  handleSlackApprovalCardClick as liveHandleApprovalCardClick,
  type ApprovalCardClickOutcome,
  type ApprovalRespondFn,
} from "./slack-approval-card.js";
import {
  parseSlackShortcutPayload,
  shortcutMessageEvent,
  shortcutWakeKey,
  type ParsedSlackShortcut,
} from "./slack-shortcut.js";

type RouteHandler = (req: Request, args: RouteHandlerArgs) => Promise<Response>;

export const PUBLIC_SLACK_ROUTE = "/eve/v1/slack";
export const INTERNAL_SLACK_ROUTE = "/eve/v1/slack/mention";

export type FrontDecision =
  | { readonly kind: "forward"; readonly reason: string }
  | { readonly kind: "wake"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "join"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "reaction"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "approval-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "setkey-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "setkey-submit"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "connect-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "grant-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "input-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "mention"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "dm-wake"; readonly reason: string; readonly env: SlackEventEnvelope; readonly dmKind: "im" | "mpim" }
  | { readonly kind: "shortcut"; readonly reason: string; readonly shortcut: ParsedSlackShortcut };

function parseOeApprovalPayload(rawBody: string): unknown | undefined {
  const raw = new URLSearchParams(rawBody).get("payload");
  if (!raw) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_APPROVAL_PREFIX),
  );
  return isOurs ? payload : undefined;
}

function decodeInteractivityPayload(rawBody: string): Record<string, unknown> | undefined {
  const raw = new URLSearchParams(rawBody).get("payload");
  if (!raw) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
}

function parseOeSetKeyClickPayload(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_SETKEY_ACTION_PREFIX),
  );
  return isOurs ? p : undefined;
}

function parseOeConnectClickPayload(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_CONNECT_ACTION_PREFIX),
  );
  return isOurs ? p : undefined;
}

function parseOeGrantClickPayload(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_GRANT_ACTION_PREFIX),
  );
  return isOurs ? p : undefined;
}

function parseOeInputClickPayload(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_INPUT_CLICK_PREFIX),
  );
  return isOurs ? p : undefined;
}

function parseOeSetKeyViewSubmission(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "view_submission") return undefined;
  const view = p.view as Record<string, unknown> | undefined;
  return view?.callback_id === OE_SETKEY_MODAL_CALLBACK ? p : undefined;
}

function interactivityFenceIds(payload: unknown): {
  readonly teamId?: string;
  readonly enterpriseId?: string;
  readonly channelId?: string;
  readonly userId?: string;
} {
  const p = payload as Record<string, unknown> | null | undefined;
  const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const channelId = str(obj(p?.channel)?.id);
  const userId = str(obj(p?.user)?.id);
  return {
    ...slackInteractivityTenantIds(payload),
    ...(channelId === undefined ? {} : { channelId }),
    ...(userId === undefined ? {} : { userId }),
  };
}

export function classifyEnvelope(rawBody: string, contentType: string): FrontDecision {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const approvalPayload = parseOeApprovalPayload(rawBody);
    if (approvalPayload !== undefined) {
      return { kind: "approval-click", reason: "block_actions oe_approval: click — ours, never forwarded", payload: approvalPayload };
    }
    const setKeyClick = parseOeSetKeyClickPayload(rawBody);
    if (setKeyClick !== undefined) {
      return { kind: "setkey-click", reason: "block_actions oe_setkey: click — ours, never forwarded", payload: setKeyClick };
    }
    const setKeySubmit = parseOeSetKeyViewSubmission(rawBody);
    if (setKeySubmit !== undefined) {
      return { kind: "setkey-submit", reason: "view_submission for our credential-intake modal — ours, never forwarded", payload: setKeySubmit };
    }
    const connectClick = parseOeConnectClickPayload(rawBody);
    if (connectClick !== undefined) {
      return { kind: "connect-click", reason: "block_actions oe_connect: click — ours, never forwarded", payload: connectClick };
    }
    const grantClick = parseOeGrantClickPayload(rawBody);
    if (grantClick !== undefined) {
      return { kind: "grant-click", reason: "block_actions oe_grant: click — ours, never forwarded", payload: grantClick };
    }
    const inputClick = parseOeInputClickPayload(rawBody);
    if (inputClick !== undefined) {
      return { kind: "input-click", reason: "block_actions oe_input: click — ours, never forwarded", payload: inputClick };
    }
    const shortcut = parseSlackShortcutPayload(decodeInteractivityPayload(rawBody));
    if (shortcut) {
      return { kind: "shortcut", reason: `${shortcut.kind} shortcut "${shortcut.callbackId}" — ours, never forwarded`, shortcut };
    }
    return { kind: "forward", reason: "urlencoded interaction/slash — slackChannel owns it" };
  }
  let env: SlackEventEnvelope;
  try {
    env = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return { kind: "forward", reason: "unparseable body — let slackChannel ack it" };
  }
  if (env?.type === "url_verification") {
    return { kind: "forward", reason: "url_verification challenge — slackChannel answers it" };
  }
  if (env?.type !== "event_callback") {
    return { kind: "forward", reason: `outer type "${String(env?.type)}" — not an event we wake on` };
  }
  const eventType = typeof env.event?.type === "string" ? env.event.type : undefined;
  if (eventType === "app_mention") {
    return { kind: "mention", reason: "app_mention — the mention path owns it unless single-window suppresses", env };
  }
  if (eventType === "member_joined_channel") {
    return { kind: "join", reason: "member_joined_channel — channel-join intro candidate", env };
  }
  if (eventType === "reaction_added" || eventType === "reaction_removed") {
    return { kind: "reaction", reason: `${eventType} — reaction ingestion candidate`, env };
  }
  if (eventType !== "message") {
    return { kind: "forward", reason: `event "${String(eventType)}" — not a message` };
  }
  const channelType = typeof (env.event as Record<string, unknown>).channel_type === "string"
    ? ((env.event as Record<string, unknown>).channel_type as string)
    : undefined;
  if (channelType === "im") {
    return { kind: "dm-wake", reason: "message.im (DM) — the DM window seat owns it", env, dmKind: "im" };
  }
  if (channelType === "mpim") {
    return { kind: "dm-wake", reason: "message.mpim (group DM) — the DM window seat owns it", env, dmKind: "mpim" };
  }
  return { kind: "wake", reason: `message.${channelType ?? "?"} — engagement wake candidate`, env };
}

export function dmFifoKey(dmChannelId: string): string {
  return `${dmChannelId}:oe-dm`;
}

const SLACK_MAX_SKEW_SECONDS = 60 * 5;

export function verifySlackSignature(
  rawBody: string,
  headers: Headers,
  signingSecret: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const timestamp = headers.get(SLACK_TIMESTAMP_HEADER);
  const signature = headers.get(SLACK_SIGNATURE_HEADER);
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SLACK_MAX_SKEW_SECONDS) return false;
  return slackSignatureMatches(signingSecret, timestamp, rawBody, signature);
}

export { EventDedupe, ThreadFifo };

let botIdentityPromise: Promise<{ readonly userId?: string; readonly botId?: string }> | undefined;

export function resolveBotIdentity(): Promise<{ readonly userId?: string; readonly botId?: string }> {
  if (!botIdentityPromise) {
    botIdentityPromise = (async () => {
      try {
        const json = (await callSlackWebApi({ botToken: undefined, operation: "auth.test", body: {} })) as {
          ok?: boolean;
          user_id?: string;
          bot_id?: string;
        };
        return json.ok ? { userId: json.user_id, botId: json.bot_id } : {};
      } catch {
        return {};
      }
    })();
  }
  return botIdentityPromise;
}

export function _resetBotIdentity(): void {
  botIdentityPromise = undefined;
}

export interface FrontOptions {
  readonly signingSecret?: string;
  readonly dedupe?: EventDedupe;
  readonly fifo?: ThreadFifo;
  readonly getBotIdentity?: () => Promise<{ readonly userId?: string; readonly botId?: string }>;
  readonly now?: () => number;
  readonly markEventSeen?: (org: string, key: string, atIso: string) => Promise<boolean>;
  readonly ambientEnabledFor?: (surfaceKey: string) => boolean;
  readonly seatedSurfaceFor?: (surfaceKey: string) => boolean;
  readonly handleApprovalPayload?: (payload: unknown, deps?: { waitUntil?: (p: Promise<unknown>) => void }) => Promise<boolean>;
  readonly handleSetKeyClick?: (payload: unknown) => Promise<boolean>;
  readonly handleSetKeyViewSubmission?: (payload: unknown) => Promise<SetKeyViewResult>;
  readonly handleConnectClick?: (payload: unknown) => Promise<boolean>;
  readonly handleGrantCardClick?: (payload: unknown) => Promise<boolean>;
  readonly handleApprovalCardClick?: (payload: unknown, respond: ApprovalRespondFn) => Promise<ApprovalCardClickOutcome>;
  readonly mentionPolicyFor?: (channelId: string, surfaceKey: string) => Promise<SingleWindowMentionPolicy>;
  readonly resolveDmSeat?: (org: string, dm: { surfaceKey: string; channelId?: string; legacyChannelId?: string }, atIso: string) => Promise<DmSeat>;
  readonly touchDmSeatFn?: (org: string, dmSurfaceKey: string, atIso: string) => Promise<void>;
  readonly dmPartnerTrustFor?: (userId: string, teamId: string | undefined) => Promise<"internal" | "external" | undefined>;
  readonly channelFactsFor?: (
    channelId: string,
  ) => Promise<{ internal: boolean; channelType?: string; appCanRead?: boolean; extShared?: boolean; trustChecked?: boolean }>;
  readonly openDirectMessageChannel?: (userId: string) => Promise<string | undefined>;
  readonly authorFactsFor?: (
    channelInternal: boolean,
    userId: string | undefined,
    teamId: string | undefined,
  ) => Promise<{ readonly surfaceInternal: boolean; readonly refuted: boolean }>;
}

const OK = () => new Response("ok");

function forwardedEnvelopeOf(rawBody: string): ForwardedSlackEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const env = parsed as SlackEventEnvelope;
  const enterpriseId = slackEnterpriseIdFromEnvelope(env);
  if (enterpriseId === undefined) return undefined;
  const event = env.event;
  const channelId = typeof event?.channel === "string" ? event.channel : undefined;
  const ts = typeof event?.ts === "string" ? event.ts : undefined;
  if (!channelId || !ts) return undefined;
  return { enterpriseId, channelId, ts };
}

function wakeKey(env: SlackEventEnvelope, channelId: string, ts: string, botIdentity = "default"): string {
  const eventId = typeof env.event_id === "string" ? env.event_id : undefined;
  return `${botIdentity}:${eventId ?? `${channelId}:${ts}`}`;
}

async function liveOpenDirectMessageChannel(userId: string): Promise<string | undefined> {
  try {
    const opened = await callSlackWebApi({ botToken: undefined, operation: "conversations.open", body: { users: userId } });
    if (opened?.ok !== true) return undefined;
    const channel = opened.channel as { id?: unknown } | undefined;
    return typeof channel?.id === "string" && channel.id.length > 0 ? channel.id : undefined;
  } catch {
    return undefined;
  }
}

const DEDUPE_TTL_MS = 10 * 60_000;
let warnedDedupeStore = false;
async function liveMarkEventSeen(org: string, key: string, atIso: string): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, DEDUPE_TTL_MS);
  } catch (err) {
    if (!warnedDedupeStore) {
      warnedDedupeStore = true;
      console.warn(`[open-everywhere:slack-front] durable dedupe unavailable — in-memory only: ${String(err)}`);
    }
    return true;
  }
}

const logOutcome =
  (path: string, channelId: string, ts: string) =>
  (outcome: RouteOutcome): void => {
    console.log(
      `[open-everywhere:slack-front] ${path} ${channelId}/${ts}: ${outcome.woke ? "woke" : "no wake"} — ${outcome.reason}`,
    );
  };

export async function deliverWithStrandRetry<T>(deliver: () => Promise<T>): Promise<T> {
  try {
    return await deliver();
  } catch (err) {
    if (!isPrunedDeploymentWakeError(err)) throw err;
    console.warn(`[open-everywhere:slack-front] wake hit a pruned deployment — seat marked for rotation, re-delivering once: ${String(err)}`);
    try {
      return await deliver();
    } catch (retryErr) {
      markUndeliveredAfterHeal(retryErr);
      throw retryErr;
    }
  }
}

export function recordWakeFailure(key: string, err: unknown): void {
  const channelId = key.split(":")[0] ?? key;
  try {
    enqueueLogRecord(buildRecord("error", "wake", "supervisor/thread wake delivery failed", { fields: { fifoKey: key, channelId }, err }));
    void flushLogShip();
  } catch {
  }
  void holdRouteWork(
    (async () => {
      try {
        const p = resolvePartition({
          channel: { kind: "slack" },
          session: { auth: { current: { attributes: { team_id: "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
        } as Parameters<typeof resolvePartition>[0]);
        const undeliveredAfterHeal = isUndeliveredAfterHeal(err);
        await getOperationalStore().appendAudit({
          ts: new Date().toISOString(),
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          action: "surface.wake_failed",
          detail: {
            fifoKey: key,
            message: String(err instanceof Error ? err.message : err).slice(0, 500),
            ...(undeliveredAfterHeal
              ? { reason: "pruned-deployment-heal-retry-failed", remedy: "seat healed for its next wake; this message got no answer" }
              : {}),
          },
        });
      } catch {
      }
    })(),
  );
}

export function withSingleWindowDiversion(
  deps: ReturnType<typeof liveSupervisorDeps>,
  to: RouteHandlerArgs["to"],
  surfaceKey: string,
): ReturnType<typeof liveSupervisorDeps> {
  return {
    ...deps,
    async wake(input) {
      if (!input.window) {
        try {
          await deps.wake(input);
        } catch (err) {
          await healPrunedDeploymentStrand({
            token: input.token,
            registryKey: surfaceKey,
            surfaceKey,
            workspace: surfaceKey.split("/")[1] ?? "unknown",
            platform: "slack",
            atIso: new Date().toISOString(),
            err,
          });
          throw err;
        }
        return;
      }
      await divertInboundToUnifiedWindow(to, {
        message: input.message,
        ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
        token: input.token,
        window: input.window,
        surfaceKey,
        auth: input.auth as { attributes?: Record<string, unknown> },
      });
    },
  };
}

async function liveDmPartnerTrust(userId: string, teamId: string | undefined): Promise<"internal" | "external" | undefined> {
  const member = await slackAuthorIsMember(userId, teamId);
  return member === undefined ? undefined : member ? "internal" : "external";
}

export function _resetDmTrustCache(): void {
  _resetAuthorMemberCache();
}

export function mentionSiblingSuppressed(input: {
  readonly authoredText: string;
  readonly subtype?: string;
  readonly botUserId?: string;
}): boolean {
  if (input.botUserId === undefined || input.botUserId.length === 0) return false;
  if (input.subtype === "message_changed") return false;
  return input.authoredText.includes(`<@${input.botUserId}>`);
}

export function buildFrontHandler(innerHandler: RouteHandler, opts: FrontOptions = {}): RouteHandler {
  const dedupe = opts.dedupe ?? new EventDedupe();
  const fifo = opts.fifo ?? new ThreadFifo(recordWakeFailure);
  const getBotIdentity = opts.getBotIdentity ?? resolveBotIdentity;
  const now = opts.now ?? (() => Date.now());
  const signingSecret = () => opts.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
  const markEventSeen = opts.markEventSeen ?? liveMarkEventSeen;
  const handleApproval =
    opts.handleApprovalPayload ??
    ((payload: unknown, deps?: { waitUntil?: (p: Promise<unknown>) => void }) =>
      liveHandleApprovalPayload(payload, { clickerIsGuest: slackClickerIsGuest, ...(deps?.waitUntil ? { waitUntil: deps.waitUntil } : {}) }));
  const handleSetKeyClick = opts.handleSetKeyClick ?? liveHandleSetKeyClick;
  const handleSetKeyViewSubmission = opts.handleSetKeyViewSubmission ?? liveHandleSetKeyViewSubmission;
  const handleConnectClick = opts.handleConnectClick ?? liveHandleConnectClick;
  const handleGrantCardClick = opts.handleGrantCardClick ?? liveHandleGrantCardClick;
  const handleApprovalCardClick = opts.handleApprovalCardClick ?? liveHandleApprovalCardClick;
  const ambientEnabledFor = opts.ambientEnabledFor ?? ((surfaceKey: string) => ambientSupervisorEnabled(surfaceKey, getConfig().loadDomains()));
  const seatedSurface = opts.seatedSurfaceFor ?? slackDomainUsesUnifiedWindow;
  const mentionPolicyFor = opts.mentionPolicyFor ?? slackSingleWindowMentionPolicy;
  const openDirectMessageChannel = opts.openDirectMessageChannel ?? liveOpenDirectMessageChannel;
  const resolveDmSeat = opts.resolveDmSeat ?? ((org, dm, atIso) => liveGetOrCreateDmSeat(org, dm, atIso));
  const touchDmSeatFn = opts.touchDmSeatFn ?? liveTouchDmSeat;
  const dmPartnerTrustFor = opts.dmPartnerTrustFor ?? liveDmPartnerTrust;
  const channelFactsFor = opts.channelFactsFor ?? slackChannelFactsFor;
  const authorFactsFor = opts.authorFactsFor ?? ((internal: boolean, userId: string | undefined, teamId: string | undefined) => slackWakeAuthorFacts(internal, userId, teamId));

  const singleWindowOwnsMention = async (channelId: string, surfaceKey: string): Promise<boolean> =>
    (await mentionPolicyFor(channelId, surfaceKey)).suppressNative;

  return (req: Request, args: RouteHandlerArgs): Promise<Response> =>
    withSlackRouteHold(() => {
      const held: RouteHandlerArgs = Object.assign(Object.create(args) as RouteHandlerArgs, {
        waitUntil: (p: Promise<unknown>) => args.waitUntil(routeHoldQuiesced(p)),
      });
      return handleFrontRequest(req, held);
    });

  async function handleFrontRequest(req: Request, args: RouteHandlerArgs): Promise<Response> {
    const rawBody = await req.text();
    if (!verifySlackSignature(rawBody, req.headers, signingSecret(), now())) {
      return new Response("unauthorized", { status: 401 });
    }
    const decision = classifyEnvelope(rawBody, req.headers.get("content-type") ?? "");

    const forwardNative = (): Promise<Response> =>
      withForwardedSlackEnvelope(forwardedEnvelopeOf(rawBody), () => {
        const fenced = stripUnfencedSlackAttachments(rawBody);
        const ts = req.headers.get(SLACK_TIMESTAMP_HEADER);
        const secret = signingSecret();
        if (fenced === rawBody || !ts || !secret) {
          return innerHandler(new Request(req.url, { method: "POST", headers: req.headers, body: rawBody }), args);
        }
        const headers = new Headers(req.headers);
        headers.set(SLACK_SIGNATURE_HEADER, slackSignature(secret, ts, fenced));
        headers.delete("content-length");
        console.log("[open-everywhere:slack-front] stripped an unfenced link-unfurl attachment before the native forward (OPE-1380)");
        return innerHandler(new Request(req.url, { method: "POST", headers, body: fenced }), args);
      });

    const send = ((input: { message: string; context?: readonly string[] }, opts: { auth: unknown; continuationToken: string; state?: unknown }) =>
      args.from(opts.continuationToken).send(input.message, {
        auth: opts.auth,
        ...(opts.state === undefined ? {} : { state: opts.state }),
        ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
      } as never)) as unknown as Parameters<typeof liveDeps>[0];

    const notYetSeenKey = async (key: string, ev: ParsedMessageEvent): Promise<boolean> => {
      if (dedupe.seen(key, now())) return false;
      dedupe.mark(key, now());
      try {
        const org = resolvePartition(bindableFor(ev)).org;
        if (!(await markEventSeen(org, key, new Date(now()).toISOString()))) return false;
      } catch {
      }
      return true;
    };

    const notYetSeen = (env: SlackEventEnvelope, ev: ParsedMessageEvent): Promise<boolean> =>
      notYetSeenKey(wakeKey(env, ev.channelId, ev.ts), ev);

    const scheduleUnownedWake = (ev: ParsedMessageEvent, label: string, directMention = false, onWake?: () => void, seatEngaged = false): void => {
      let ambient = false;
      let surfaceKey: string | undefined;
      try {
        surfaceKey = resolvePartition(bindableFor(ev)).surfaceKey;
        ambient = ambientEnabledFor(surfaceKey);
      } catch {
        ambient = false;
      }
      const seated = surfaceKey !== undefined && seatedSurface(surfaceKey);
      if (directMention && !ambient && !seated) {
        console.warn(`[open-everywhere:slack-front] ${label} ${ev.channelId}/${ev.ts}: addressed wake with no standing seat and ambient off — dropped (no road to a seat)`);
        return;
      }
      const addressedOrAmbient = directMention || ambient || seatEngaged;
      onWake?.();
      if (addressedOrAmbient) {
        const supKey = supervisorFifoKey(ev.channelId);
        args.waitUntil(
          fifo.enqueue(supKey, () =>
            deliverWithStrandRetry(() =>
              routeSupervisorEvent(
                ev,
                withSingleWindowDiversion(liveSupervisorDeps(send), args.to, surfaceKey!),
                directMention ? { directMention: true } : undefined,
              ).then(logOutcome(`${label}-supervisor`, ev.channelId, ev.ts)),
            ),
          ),
        );
        return;
      }
      const seatRoute = seated
        ? async (hydrateContext: NameDropContextHydrator): Promise<RouteOutcome> => {
            let outcome: RouteOutcome = { deliver: false, reason: "seat wake delivery failed", woke: false };
            await fifo.enqueue(supervisorFifoKey(ev.channelId), async () => {
              outcome = await deliverWithStrandRetry(() =>
                routeSupervisorEvent(ev, withSingleWindowDiversion(liveSupervisorDeps(send), args.to, surfaceKey!), {
                  nameDrop: true,
                  nameDropContext: hydrateContext,
                }),
              );
            });
            return outcome;
          }
        : undefined;
      args.waitUntil(
        routeNameDropEvent(ev, { ...liveNameDropDeps(send), ...(seatRoute ? { seatRoute } : {}) }).then(
          logOutcome(seatRoute ? `${label}-name-drop-seat` : label, ev.channelId, ev.ts),
        ),
      );
    };

    const scheduleDmWake = async (
      ev: ParsedMessageEvent,
      dmKind: "im" | "mpim",
      driverAdmitted = false,
    ): Promise<void> => {
      if (slackFrontTenantFenceDeclined(ev, `dm-${dmKind}`, "scheduleDmWake")) return;
      const p = resolvePartition(bindableFor(ev));
      const atIso = new Date(now()).toISOString();
      const isGroup = dmKind === "mpim";
      const partnerTrust = !isGroup && ev.userId ? await dmPartnerTrustFor(ev.userId, ev.teamId) : undefined;
      const roomFacts = isGroup ? await channelFactsFor(ev.channelId) : undefined;
      const surfaceInternal = isGroup ? roomFacts?.internal === true : partnerTrust === "internal";
      const authorRefuted = isGroup ? (await authorFactsFor(surfaceInternal, ev.userId, ev.teamId)).refuted : partnerTrust === "external";
      const wakeTrust = resolveWakeTrust({
        authorIsBot: Boolean(ev.botId) && !driverAdmitted,
        authorId: ev.userId,
        surfaceInternal,
        channelKey: p.surfaceKey,
      });
      {
        const verdict = await applySlackExternalPolicy(ev, p, { trust: wakeTrust, refuted: authorRefuted }, "scheduleDmWake");
        if (verdict !== "proceed") {
          console.log(`[open-everywhere:slack-front] dm ${p.surfaceKey}: suppressed — externalPolicy verdict "${verdict}"`);
          return;
        }
      }
      const seat = await resolveDmSeat(
        p.org,
        { surfaceKey: p.surfaceKey, channelId: ev.channelId, ...(isGroup ? {} : { legacyChannelId: ev.channelId }) },
        atIso,
      );
      const wakeId = mintWakeId();
      const auth = stampNonMemberChatAuth(
        buildSlackAuth({
          userId: ev.userId ?? "",
          teamId: ev.teamId,
          ...(ev.enterpriseId === undefined ? {} : { enterpriseId: ev.enterpriseId }),
          channelId: ev.channelId,
          threadTs: ev.threadTs,
          channelType: dmKind,
          isPrivate: true,
          ...(partnerTrust ? { dmPartnerTrust: partnerTrust } : {}),
          ...(roomFacts?.extShared === undefined ? {} : { isExternal: roomFacts.extShared }),
          ...(roomFacts?.trustChecked === undefined ? {} : { trustChecked: roomFacts.trustChecked }),
        }),
        [{ trust: wakeTrust, refuted: authorRefuted }],
        { dm: true },
      );
      const message = renderWakeMessage(ev, () => atIso, {
        dm: true,
        trust: wakeTrust,
        triggerRefuted: authorRefuted || undefined,
        wakeId,
        ...(seat.freshGeneration && seat.tail.length > 0 ? { backscroll: seat.tail } : {}),
      });

      const origin = { platform: "slack" as const, channelId: ev.channelId, ...(ev.threadTs ? { threadTs: ev.threadTs } : {}) };
      await divertInboundToUnifiedWindow(args.to, {
        message,
        token: seat.token,
        window: { wakeId, origin, addressing: "direct-mention", ...spreadVendorTs(slackVendorEventTime(ev.ts)) },
        surfaceKey: p.surfaceKey,
        auth,
      });
      args.waitUntil(touchDmSeatFn(p.org, p.surfaceKey, atIso).catch(() => {}));
      args.waitUntil(
        recordWakeTail(p.org, dmWindowRegistryKey(p.surfaceKey), seat.token, {
          kind: "wake",
          at: atIso,
          from: "human",
          trust: wakeTrust,
          ...tailAuthorGrain({ trust: wakeTrust, refuted: authorRefuted }),
          author: ev.userId ?? "unknown",
          ...(ev.userId ? { authorId: ev.userId } : {}),
          ...(ev.ts ? { id: ev.ts } : {}),
          platform: "slack",
          container: p.surfaceKey,
          text: ev.text ?? "",
        }),
      );
    };

    const registerAttachments = (ev: ParsedMessageEvent): void => {
      for (const a of ev.attachments ?? []) {
        if (a.kind === "image" && a.id && a.url) {
          registerSlackAttachment(a.id, { urlPrivate: a.url, mimeType: a.mimeType, name: a.name, ...(ev.teamId ? { teamId: ev.teamId } : {}) });
        }
      }
    };

    const persistAttachments = (ev: ParsedMessageEvent): void => {
      const atts = ev.attachments;
      if (!atts || atts.length === 0) return;
      let org: string;
      try {
        org = resolvePartition(bindableFor(ev)).org;
      } catch {
        return;
      }
      for (const a of atts) {
        if (a.id && a.url) {
          args.waitUntil(persistSlackAttachment(a.id, { urlPrivate: a.url, mimeType: a.mimeType, name: a.name, teamId: ev.teamId }, org));
        }
      }
    };

    const fencedAck = (res: Response): Response => {
      args.waitUntil(Promise.resolve());
      return res;
    };

    if (decision.kind === "forward") {
      return forwardNative();
    }

    if (decision.kind === "dm-wake") {
      const dev = parseMessageEvent(decision.env);
      if (!dev) {
        console.log(`[open-everywhere:slack-front] ${decision.dmKind} wake dropped — the envelope parsed to no channel/ts`);
        return OK();
      }
      if (slackFrontTenantFenceDeclined(dev, `dm-${decision.dmKind}`, "front-dm-branch")) return fencedAck(OK());
      const driverAdmitted = Boolean(dev.botId) && dmDoorAdmitsDriver(dev) && dev.botId !== (await getBotIdentity()).botId;
      if (driverAdmitted) {
        args.waitUntil(
          auditDmDriverAdmitted(dev, decision.dmKind).catch(() => {
          }),
        );
        console.log(
          `[open-everywhere:slack-front] ${decision.dmKind} ${dev.channelId}/${dev.ts}: bot-authored DM ADMITTED — the named e2e driver identity (bot ${dev.botId} in team ${dev.teamId ?? "?"})`,
        );
      } else if (dev.botId) {
        args.waitUntil(
          (async () => {
            const { botId: selfBotId } = await getBotIdentity();
            if (await auditDmBotAuthorDrop(dev, decision.dmKind, selfBotId)) {
              console.log(
                `[open-everywhere:slack-front] ${decision.dmKind} ${dev.channelId}/${dev.ts}: bot-authored DM dropped — no turn (bot ${dev.botId} in team ${dev.teamId ?? "?"}; the DM door admits no bot author)`,
              );
            }
          })().catch(() => {
          }),
        );
        return OK();
      }
      if (decision.dmKind === "mpim") {
        const { userId: dmBotUserId } = await getBotIdentity();
        if (
          mentionSiblingSuppressed({
            authoredText: dev.authoredText,
            ...(dev.subtype === undefined ? {} : { subtype: dev.subtype }),
            ...(dmBotUserId === undefined ? {} : { botUserId: dmBotUserId }),
          })
        ) {
          return OK();
        }
      }
      persistAttachments(dev);
      if (!(await notYetSeen(decision.env, dev))) return OK();
      args.waitUntil(
        fifo.enqueue(dmFifoKey(dev.channelId), async () => {
          await deliverWithStrandRetry(() => scheduleDmWake(dev, decision.dmKind, driverAdmitted));
          console.log(`[open-everywhere:slack-front] ${decision.dmKind} ${dev.channelId}/${dev.ts}: woke — diverted to the DM window seat`);
        }),
      );
      return OK();
    }

    if (decision.kind === "shortcut") {
      const sc = decision.shortcut;
      const shortcutChannelId = sc.kind === "message" ? sc.channelId : await openDirectMessageChannel(sc.userId);
      if (!shortcutChannelId) {
        console.log(
          `[open-everywhere:slack-front] ${sc.kind} shortcut "${sc.callbackId}" from ${sc.userId}: no channel to wake in ` +
            `(a global shortcut opens the invoker's DM, which needs the im:write bot scope) — nothing woken`,
        );
        return new Response(null, { status: 200 });
      }
      const shortcutFacts =
        sc.kind === "global"
          ? { channelType: "im" as string | undefined, appCanRead: true }
          : await channelFactsFor(shortcutChannelId)
              .then((f) => ({ channelType: f.channelType, appCanRead: f.appCanRead === true }))
              .catch(() => ({ channelType: undefined as string | undefined, appCanRead: false }));
      const shortcutChannelType = shortcutFacts.channelType;
      if (!shortcutChannelType) {
        console.warn(
          `[open-everywhere:slack-front] ${sc.kind} shortcut "${sc.callbackId}" in ${shortcutChannelId}: ` +
            `conversations.info resolved no channel type — dropped (a shortcut never routes on an unresolved room)`,
        );
        return new Response(null, { status: 200 });
      }
      if (sc.kind === "message" && !shortcutFacts.appCanRead && (sc.message?.attachments?.length ?? 0) > 0) {
        console.warn(
          `[open-everywhere:slack-front] ${sc.kind} shortcut "${sc.callbackId}" in ${shortcutChannelId}: ` +
            `withheld ${sc.message?.attachments?.length} file reference(s) — the app cannot read that conversation`,
        );
      }
      const sev = shortcutMessageEvent(sc, shortcutChannelId, shortcutChannelType, now(), { admitAttachments: shortcutFacts.appCanRead });
      if (slackFrontTenantFenceDeclined(sev, `${sc.kind}-shortcut`, "front-shortcut-branch")) return fencedAck(new Response(null, { status: 200 }));
      if (!(await notYetSeenKey(shortcutWakeKey(sc), sev))) return new Response(null, { status: 200 });
      const seedAttachments = (): void => {
        registerAttachments(sev);
        persistAttachments(sev);
      };
      if (shortcutChannelType === "im" || shortcutChannelType === "mpim") {
        seedAttachments();
        args.waitUntil(
          fifo.enqueue(dmFifoKey(shortcutChannelId), async () => {
            await deliverWithStrandRetry(() => scheduleDmWake(sev, shortcutChannelType));
            console.log(`[open-everywhere:slack-front] ${sc.kind} shortcut "${sc.callbackId}": woke the ${shortcutChannelType} window ${shortcutChannelId}`);
          }),
        );
        return new Response(null, { status: 200 });
      }
      scheduleUnownedWake(sev, `${sc.kind}-shortcut`, true, seedAttachments);
      return new Response(null, { status: 200 });
    }

    if (decision.kind === "mention") {
      const mev = parseMessageEvent(decision.env);
      if (mev) persistAttachments(mev);
      let owned = false;
      if (mev) {
        try {
          owned = await singleWindowOwnsMention(mev.channelId, resolvePartition(bindableFor(mev)).surfaceKey);
        } catch {
          owned = false;
        }
      }
      if (owned && mev) {
        if (!(await notYetSeen(decision.env, mev))) return OK();
        console.log(
          `[open-everywhere:slack-front] app_mention ${mev.channelId}/${mev.ts}: single-window — diverting to the unified supervisor (native forward suppressed)`,
        );
        scheduleUnownedWake(mev, "single-window-mention", true);
        return OK();
      }
      if (mev) {
        const mentionChannelType = await channelFactsFor(mev.channelId)
          .then((f) => f.channelType)
          .catch(() => undefined);
        if (mentionChannelType === "mpim") {
          if (!(await notYetSeen(decision.env, mev))) return OK();
          console.log(
            `[open-everywhere:slack-front] app_mention ${mev.channelId}/${mev.ts}: group DM — diverting to the mpim window seat (native forward suppressed)`,
          );
          args.waitUntil(
            fifo.enqueue(dmFifoKey(mev.channelId), async () => {
              await deliverWithStrandRetry(() => scheduleDmWake({ ...mev, channelType: "mpim" }, "mpim"));
            }),
          );
          return OK();
        }
        if (mentionChannelType === undefined) {
          console.log(
            `[open-everywhere:slack-front] app_mention ${mev.channelId}/${mev.ts}: channel type unresolved (conversations.info unavailable; a group-DM mention needs the mpim:read scope) — forwarding to the native mention path`,
          );
        }
      }
      if (mev) {
        try {
          const p = resolvePartition(bindableFor(mev));
          const roomKey = domainKeyOf(p);
          if (!externalPolicyIsInert(slackExternalPolicyForRoom(roomKey))) {
            const internal = (await channelFactsFor(mev.channelId).catch(() => ({ internal: false }))).internal;
            const facts = await authorFactsFor(internal, mev.userId, mev.teamId);
            const wakeTrust = resolveWakeTrust({
              authorIsBot: Boolean(mev.botId),
              authorId: mev.userId,
              surfaceInternal: facts.surfaceInternal,
              channelKey: roomKey,
            });
            const verdict = await applySlackExternalPolicy(mev, p, { trust: wakeTrust, refuted: facts.refuted }, "native-mention-forward");
            if (verdict !== "proceed") {
              console.log(`[open-everywhere:slack-front] app_mention ${mev.channelId}/${mev.ts}: suppressed — externalPolicy verdict "${verdict}" (native forward withheld)`);
              return OK();
            }
          }
        } catch {
        }
      }
      return forwardNative();
    }

    if (decision.kind === "approval-click") {
      if (slackInteractivityTenantFenceDeclined(interactivityFenceIds(decision.payload), "approval-click", "front-interactivity-branch")) {
        return fencedAck(new Response(null, { status: 200 }));
      }
      if (await handleApproval(decision.payload, { waitUntil: args.waitUntil })) {
        return new Response(null, { status: 200 });
      }
      return forwardNative();
    }

    if (decision.kind === "setkey-click") {
      if (slackInteractivityTenantFenceDeclined(interactivityFenceIds(decision.payload), "setkey-click", "front-interactivity-branch")) {
        return fencedAck(new Response(null, { status: 200 }));
      }
      if (await handleSetKeyClick(decision.payload)) {
        return new Response(null, { status: 200 });
      }
      return forwardNative();
    }

    if (decision.kind === "connect-click") {
      if (slackInteractivityTenantFenceDeclined(interactivityFenceIds(decision.payload), "connect-click", "front-interactivity-branch")) {
        return fencedAck(new Response(null, { status: 200 }));
      }
      if (await handleConnectClick(decision.payload)) {
        return new Response(null, { status: 200 });
      }
      return forwardNative();
    }

    if (decision.kind === "grant-click") {
      if (slackInteractivityTenantFenceDeclined(interactivityFenceIds(decision.payload), "grant-click", "front-interactivity-branch")) {
        return fencedAck(new Response(null, { status: 200 }));
      }
      if (await handleGrantCardClick(decision.payload)) {
        return new Response(null, { status: 200 });
      }
      return forwardNative();
    }

    if (decision.kind === "input-click") {
      if (slackInteractivityTenantFenceDeclined(interactivityFenceIds(decision.payload), "input-click", "front-interactivity-branch")) {
        return fencedAck(new Response(null, { status: 200 }));
      }
      const respondToApproval: ApprovalRespondFn = async (bareToken, response) => {
        await (args.from(bareToken) as unknown as { respond: (r: readonly unknown[], o: unknown) => Promise<unknown> }).respond([response], {});
      };
      const tap = await handleApprovalCardClick(decision.payload, respondToApproval);
      console.log(`[open-everywhere:slack] oe_input: tap — ${tap.reason}`);
      if (!tap.handled) return forwardNative();
      return new Response(null, { status: 200 });
    }

    if (decision.kind === "setkey-submit") {
      if (slackInteractivityTenantFenceDeclined(interactivityFenceIds(decision.payload), "setkey-submit", "front-interactivity-branch")) {
        return fencedAck(new Response(null, { status: 200 }));
      }
      const result = await handleSetKeyViewSubmission(decision.payload);
      if (result.handled) {
        return result.response
          ? new Response(JSON.stringify(result.response), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(null, { status: 200 });
      }
      return forwardNative();
    }

    if (decision.kind === "join") {
      const jev = parseChannelJoinEvent(decision.env);
      if (!jev) return OK();
      const { userId: joinBotUserId } = await getBotIdentity();
      if (!joinBotUserId || jev.userId !== joinBotUserId) return OK();

      const joinKey = wakeKey(decision.env, jev.channelId, jev.ts);
      if (dedupe.seen(joinKey, now())) return OK();
      dedupe.mark(joinKey, now());
      try {
        const org = resolvePartition(bindableForJoin(jev)).org;
        if (!(await markEventSeen(org, joinKey, new Date(now()).toISOString()))) return OK();
      } catch {
      }

      const joinSend = send;
      args.waitUntil(
        routeChannelJoinEvent(jev, liveChannelJoinDeps(joinSend)).then(logOutcome("channel-join", jev.channelId, jev.ts)),
      );
      return OK();
    }

    if (decision.kind === "reaction") {
      const rev = parseSlackReactionEvent(decision.env);
      if (!rev) return OK();

      const reactionEnterpriseId = slackEnterpriseIdFromEnvelope(decision.env);
      if (
        slackInteractivityTenantFenceDeclined(
          {
            ...(rev.teamId === undefined ? {} : { teamId: rev.teamId }),
            ...(reactionEnterpriseId === undefined ? {} : { enterpriseId: reactionEnterpriseId }),
            channelId: rev.channelId,
            userId: rev.reactorId,
          },
          "reaction",
          "front-reaction-branch",
        )
      ) {
        return fencedAck(OK());
      }

      const rkey = wakeKey(decision.env, rev.channelId, rev.messageTs);
      if (dedupe.seen(rkey, now())) return OK();
      dedupe.mark(rkey, now());
      try {
        const org = resolvePartition(bindableForReaction(rev)).org;
        if (!(await markEventSeen(org, rkey, new Date(now()).toISOString()))) return OK();
      } catch {
      }

      const identity = await getBotIdentity();
      args.waitUntil(
        routeReactionEvent(rev, liveReactionDeps(identity, args.attachSession)).then((o) =>
          console.log(`[open-everywhere:slack-front] reaction ${rev.channelId}/${rev.messageTs}: ${o.recorded ? "recorded" : "not recorded"} — ${o.reason}`),
        ),
      );
      return OK();
    }

    const ev = parseMessageEvent(decision.env);
    if (!ev) return OK();
    persistAttachments(ev);

    const { userId: botUserId } = await getBotIdentity();
    if (mentionSiblingSuppressed({ authoredText: ev.authoredText, ...(ev.subtype === undefined ? {} : { subtype: ev.subtype }), ...(botUserId === undefined ? {} : { botUserId }) })) {
      return OK();
    }

    if (!(await notYetSeen(decision.env, ev))) return OK();

    if (!ev.threadTs) {
      scheduleUnownedWake(ev, "name-drop");
      return OK();
    }

    const p = resolvePartition(bindableFor(ev));
    if (seatedSurface(p.surfaceKey)) {
      const seatEngaged = await isThreadEngaged(p, ev.threadTs).catch(() => false);
      scheduleUnownedWake(ev, "in-thread-window", false, undefined, seatEngaged);
      return OK();
    }

    const engaged = await isThreadEngaged(p, ev.threadTs);
    if (!engaged) {
      scheduleUnownedWake(ev, "name-drop-thread");
      return OK();
    }

    const threadKey = slackContinuationToken(ev.channelId, ev.threadTs);
    args.waitUntil(
      fifo.enqueue(threadKey, () => routeMessageEvent(ev, liveDeps(send)).then(logOutcome("engaged-thread", ev.channelId, ev.threadTs!))),
    );
    return OK();
  }
}

export function frontSlackChannel<C extends Channel<any, any, any>>(inner: C, opts: FrontOptions = {}): C {
  const innerPost = inner.routes.find(
    (r): r is HttpRouteDefinition<any> => r.method === "POST" && r.path === INTERNAL_SLACK_ROUTE,
  );
  if (!innerPost) {
    throw new Error(
      `frontSlackChannel: wrapped slackChannel must be built with route: "${INTERNAL_SLACK_ROUTE}" ` +
        `(found paths: ${inner.routes.map((r) => r.path).join(", ")})`,
    );
  }
  const front = buildFrontHandler(innerPost.handler, opts);
  return { ...inner, routes: [POST(PUBLIC_SLACK_ROUTE, front), ...inner.routes] };
}
