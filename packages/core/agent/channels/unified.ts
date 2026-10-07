import { defineChannel, GET, POST } from "eve/channels";
import type { ChannelEvents, Session, RouteHandlerArgs } from "eve/channels";
import { defineState } from "eve/context";
import { SELF_DISPATCH_PATH, handleSelfDispatch, postSelfDispatch, selfDispatchConfigured, type UnifiedDispatchPayload } from "./self-dispatch.js";
import { appendAudit, auditSilencesEnabled } from "../audit/audit.js";
import { deploymentOrg, currentWakeId, currentTurnId, currentTurnAddressing, currentTurnAddressed, bindFrom, carriesPlatformIdentity, WORK_FIRE_CREATOR_ATTR, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { isFrozenSurfaceBinding, OE_FROZEN_SURFACE_BINDING_ATTR } from "../identity/frozen-surface-binding.internal.js";
import { getConfig } from "../access/config.js";
import "../access/eve-patch-probe-boot.js";
import { windowedSupervisorEnabled, domainRoster } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { registerUnifiedWakeTarget, resolveUnifiedWakeAuthority, resolveUnifiedWakeTarget, isUnifiedWakeAuthority, isUnifiedWakeOrigin, mintWakeId, stampUnifiedWindowAuth, proseBlockingRefusal, unifiedThreadRef, unifiedPlacementRef, sameUnifiedContainer, isThreadScopedWakeOrigin, wakeBindingMatchesOrigin, wakeBindingMatchesSurfaceKey, OE_ADDRESSING_ATTR, OE_GRAIN_ATTR, OE_TASK_LABEL_ATTR, type UnifiedWakeAuthority, type UnifiedWakeOrigin, type UnifiedWindowWake } from "./unified-window.js";
import {
  WAKE_INGRESS_ACTION,
  wakeIngressDetail,
  WAKE_RETRY_ACTION,
  wakeRetryDetail,
  WAKE_DISPATCH_RETRY_POLICY,
  WAKE_DISPATCH_OPERATION,
} from "./wake-timing.js";
import { withRetryAfterThrown, isRateLimitThrow, RateLimitExhaustedError } from "./rate-limit-retry.js";
import { postUnifiedReply, completeUnifiedSessionSilently } from "./unified-reply.js";
import { canPostUnifiedActions, postArm } from "./post-arms.js";
import { approvalCardActions, mintApprovalCardTicket, rememberApprovalCardTicket } from "./approval-card.js";
import { containerAnsweredSince } from "./answered-container-ledger.js";
import { isWakeEnvelopeShaped, triggerMessageBody } from "./wake-envelope.js";
import {
  detectBridgeableInputRequest,
  bridgeQuestionToSurface,
  forgetBridgedQuestion,
  settleAnsweredWake,
  readBridgedQuestion,
  ordinaryWakeSendOptions,
  bridgedQuestionMayBeOpen,
  rememberBridgedQuestion,
  resolveInboundAnswerRouting,
  isAddressedMentionWake,
  approvalOptionIds,
  QUESTION_ANSWERED_AUDIT_ACTION,
  QUESTION_ANSWER_DROPPED_AUDIT_ACTION,
  QUESTION_DROPPED_AUDIT_ACTION,
} from "./question-bridge.js";
import { admitInputResponse } from "../approvals/input-response-floor.js";
import { resolvePartition } from "../memory/partition.js";
import { encodeCarriedWrites, OE_WORK_RESULT_WRITES_ATTR, type DurableMemoryWrite } from "../memory/write-evidence.js";
import { unifiedDomainFromToken, unifiedDomainSessionKey, isUnifiedSupervisorToken } from "./unified-supervisor.js";
import { parseWindowToken, isTaskWindowId, isThreadSeatWindowId, isThreadSeatWindowToken, isWorkWindowToken, dmAnchorSurfaceForToken, dmSurfaceKeyFromAnchorDomain, bareTokenFromEveContext } from "./window-key.js";
import { resolveThreadOwner, clearThreadOwner, routeThreadMessage } from "./thread-ownership.js";
import { drainGenerationRetirements } from "./generation-retirement.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { INGESTION_KINDS } from "../access/taint-tiers.js";
import { INVOKER_POSTURE_ATTR, narrowerInvokerPosture, type InvokerPosture } from "../access/invoker-posture.js";
import { currentInvokerPosture } from "../access/invoker-posture-state.js";
import {
  OE_REQUESTER_ATTR,
  OE_REQUESTER_CANDIDATES_ATTR,
  REQUESTER_UNVERIFIED,
  requesterCandidatesStampForDispatch,
  requesterStampForDispatch,
  requesterVerdictFor,
  type RequesterVerdict,
} from "../access/requester-identity.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../access/taint-signal.js";
import { rememberNonMemberAnswer } from "../access/held-question.js";
import { carryRunRefusalsToRedrive, dropCarriedRunRefusals } from "../approvals/card-signal.js";
import { DELEGATION_PENDING_REFUSAL_REASON, pendingDelegationOwing } from "../access/pending-delegation-signal.js";
import { addressedWakeThisTurn } from "../access/dispatch-origin-signal.js";
import { OE_WORK_REQUEST_ATTR, OE_WORK_RESULT_ATTR, OE_WORK_RESULT_OWED_ATTR, OE_WORK_RESULT_READS_ATTR, OE_WORK_SEAT_SESSION_ATTR, OE_WORK_SEAT_WAKE_ATTR } from "./work.js";
import { OE_OWN_ACCOUNT_ASK_ATTR } from "../connections/own-account-carriage.js";
import { deliveryChangedThisTurn } from "../access/task-wake-signal.js";
import { sourcesForWindow, windowSourcesNeedConfig } from "./window-sources.js";
import { finalMessageActionForTurn, isBareStop, NO_REPLY_SENTINEL_REASON } from "./turn-delivery.js";
import { auditNoReplySentinelObserved } from "./chat-turn-audit.js";
import { consumeRepliedThisTurn, repliedWakesThisTurn, declinedWakesThisTurn, refusalsForWakeThisTurn } from "./reply-signal.js";
import { replyCarriesSubstance } from "./reply-post.js";
import { consumeReactedThisTurn } from "./react-signal.js";
import { settleWakeAccounting, UNACCOUNTED_WAKES_AUDIT_ACTION, WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION, MAX_ACCOUNTING_WAKES } from "./wake-accounting.js";
import { maybeRedrive, type RedriveReinject } from "./unified-redrive.js";
import { unresumableAuditDetail } from "./session-resume.js";
import { healPrunedDeploymentStrand } from "./stranded-seat.js";
import { admitInboundSurface, providerSelection } from "../access/provider-selection.js";
import { ingressSpendGate } from "../spend/ingress-gate.js";

function ulog(msg: string): void {
  console.log(`[open-everywhere:unified] ${msg}`);
}

type UnifiedSendAuth = Parameters<ReturnType<RouteHandlerArgs["to"]>["send"]>[1]["auth"];

export function completeWakeAuth(
  auth:
    | {
        readonly attributes?: Readonly<Record<string, unknown>>;
        readonly authenticator?: string;
        readonly principalId?: string;
        readonly principalType?: string;
      }
    | null
    | undefined,
): UnifiedSendAuth {
  return {
    ...auth,
    attributes: auth?.attributes ?? {},
    authenticator: auth?.authenticator ?? "",
    principalId: auth?.principalId ?? "",
    principalType: auth?.principalType ?? "",
  } as UnifiedSendAuth;
}

let rememberedReceive: RouteHandlerArgs["to"] | undefined;

function authString(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}
function rememberUnifiedReceive(to: RouteHandlerArgs["to"]): void {
  rememberedReceive = to;
}

async function deliverUnifiedDispatch(input: UnifiedDispatchPayload): Promise<void> {
  if (rememberedReceive) return divertToUnifiedWindow(rememberedReceive, { ...input, internalDispatch: true });
  await postSelfDispatch(input);
}

function crossProcessDispatchAvailable(): boolean {
  return rememberedReceive !== undefined || selfDispatchConfigured();
}

function pickRedriveSurfaceKey(domain: string | undefined, platform: string, windowId?: string): string | null {
  if (!domain) return null;
  const dmSurface = dmSurfaceKeyFromAnchorDomain(domain);
  if (dmSurface) return dmSurface;
  if (windowId !== undefined && windowId.startsWith(`${platform}/`) && windowId.split("/").length >= 3) return windowId;
  try {
    const d = getConfig().loadDomains().find((dm) => dm.name === domain && domainRoster(dm).length > 0);
    const roster = d ? domainRoster(d) : [];
    if (roster.length === 0) return null;
    return roster.find((c) => c.startsWith(`${platform}/`)) ?? roster[0]!;
  } catch {
    return null;
  }
}

export interface UnifiedReceiveTarget {
  readonly token: string;
  readonly wakeId: string;
  readonly origin: UnifiedWakeOrigin;
  readonly surfaceKey: string;
  readonly authority?: UnifiedWakeAuthority;
  readonly context?: readonly string[];
  readonly answer?: {
    readonly requestId: string;
    readonly floor: string;
    readonly optionId?: string;
    readonly nonMember?: true;
  };
  readonly inbound?: boolean;
  readonly addressing?: string;
}

export function windowEnabledFor(surfaceKey: string, token: string): boolean {
  const dmAnchorSurface = dmAnchorSurfaceForToken(token);
  if (dmAnchorSurface !== undefined) return dmAnchorSurface === surfaceKey;
  try {
    const domains = getConfig().loadDomains();
    return windowedSupervisorEnabled(surfaceKey, domains);
  } catch {
    return false;
  }
}

export function auditLabels(rawToken: string | undefined): { workspace: string; surface: string | undefined } {
  const key = parseWindowToken(rawToken);
  return {
    workspace: key ? platformWorkspaceForWindowDomain(key.domain) : "unknown",
    surface: key ? unifiedDomainSessionKey(key.windowId) : undefined,
  };
}

export function platformWorkspaceForWindowDomain(domain: string): string {
  const surfaceKey = dmSurfaceKeyFromAnchorDomain(domain);
  if (surfaceKey === undefined) return domain;
  return surfaceKey.split("/")[1] || domain;
}

export function ambientProseDropDetail(
  rawAddressing: string | undefined,
  addressed: boolean,
  replied: boolean,
  blockingRefusal: string | undefined,
  carriesSubstance: boolean,
): { readonly addressing: string; readonly reason: string } {
  return {
    addressing: rawAddressing ?? (addressed ? "addressed-other" : "ambient"),
    reason: replied
      ? "narration-after-reply"
      : blockingRefusal !== undefined
        ? `refused:${blockingRefusal}`
        : carriesSubstance || !addressed
          ? "no-reply-call"
          : NO_SUBSTANCE_DROP_REASON,
  };
}

export function proseDropClosesWakeSession(answeredThisWake: boolean, redriven: boolean): boolean {
  return !answeredThisWake && !redriven;
}

export const NO_SUBSTANCE_DROP_REASON = "no-substance";

export function proseDropMayRedrive(input: { readonly replied: boolean; readonly blockingRefusal: string | undefined; readonly token: string | undefined; readonly turnId: string | undefined }): boolean {
  if (input.replied || input.blockingRefusal !== undefined || input.token === undefined) return false;
  return !deliveryChangedThisTurn(input.turnId);
}

export async function answeredSameContainerThisTurn(org: string, turnId: string | undefined, wakeId: string | undefined, origin: UnifiedWakeOrigin): Promise<boolean> {
  const replied = repliedWakesThisTurn(turnId).filter((w) => w !== wakeId);
  if (replied.length === 0) return false;
  if (deliveryChangedThisTurn(turnId)) return false;
  const store = getOperationalStore();
  for (const w of replied) {
    const other = await resolveUnifiedWakeTarget(store, org, w).catch(() => null);
    if (other && sameUnifiedContainer(other, origin)) return true;
  }
  return false;
}

export async function answeredContainerVia(org: string, turnId: string | undefined, wakeId: string | undefined, origin: UnifiedWakeOrigin): Promise<"turn" | "container" | undefined> {
  if (await answeredSameContainerThisTurn(org, turnId, wakeId, origin)) return "turn";
  if (wakeId === undefined) return undefined;
  const record = await getOperationalStore()
    .getUnifiedWakeRecord(org, wakeId)
    .catch(() => null);
  if (!record) return undefined;
  return (await containerAnsweredSince(org, origin, record.createdAt)) ? "container" : undefined;
}

export async function auditUnaccountedWakesForTurn(
  org: string,
  workspace: string,
  surface: string | undefined,
  windowToken: string | undefined,
  turnId: string | undefined,
  turnWake: string | undefined,
  reacted: boolean,
): Promise<void> {
  if (isWorkWindowToken(windowToken)) return;
  if (!windowToken || !turnId || !turnWake) {
    const reason = !windowToken ? "no-window-token" : !turnId ? "no-turn-id" : "no-turn-wake";
    await appendAudit({
      org,
      platform: "unified",
      workspace,
      surface,
      action: WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION,
      detail: { reason },
    }).catch(() => undefined);
    return;
  }
  try {
    const accounted = new Set<string>([...repliedWakesThisTurn(turnId), ...declinedWakesThisTurn(turnId)]);
    if (reacted) accounted.add(turnWake);
    const unaccounted = await settleWakeAccounting(getOperationalStore(), org, { windowToken, turnWake }, accounted);
    if (unaccounted.length === 0) return;
    const addressedCount = unaccounted.filter((w) => w.addressing === "addressed").length;
    await appendAudit({
      org,
      platform: "unified",
      workspace,
      surface,
      action: UNACCOUNTED_WAKES_AUDIT_ACTION,
      detail: {
        turnId,
        turnWake,
        unaccounted: unaccounted.map((w) => ({ wakeId: w.wakeId, addressing: w.addressing })),
        count: unaccounted.length,
        addressedCount,
        ambientCount: unaccounted.length - addressedCount,
        capped: unaccounted.length >= MAX_ACCOUNTING_WAKES,
      },
    }).catch(() => undefined);
  } catch {
  }
}

function failureDiag(code: string | undefined, details: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof code === "string" && code.length > 0) out.code = code;
  if (details && typeof details === "object") {
    for (const k of ["errorId", "name", "statusCode", "generationId", "gatewayName", "gatewayType", "upstreamType", "upstreamStatusCode", "upstreamMessage"]) {
      const v = details[k];
      if (typeof v === "string" && v.length > 0) out[k] = v.slice(0, 200);
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    }
  }
  return out;
}

function windowSourcesForDivert(token: string, originPlatform: string): readonly string[] {
  try {
    const key = parseWindowToken(token);
    if (key) {
      const domains = windowSourcesNeedConfig(key.windowId, key.domain) ? getConfig().loadDomains() : [];
      const s = sourcesForWindow(key.windowId, key.domain, domains);
      if (s.length > 0) return s;
    }
  } catch {
  }
  return [originPlatform];
}

async function windowSpendGate(input: {
  readonly window: UnifiedWindowWake;
  readonly auth: { attributes?: Record<string, unknown> };
}): Promise<"proceed" | "declined"> {
  const platform = input.window.origin.platform;
  const bindable = { channel: { kind: platform }, session: { auth: { current: input.auth } } } as unknown as BindableContext;
  const principalId = bindFrom(bindable).principalId;
  return ingressSpendGate({
    bindable,
    door: "window",
    ...(principalId !== undefined ? { principalId } : {}),
    post: async (text) => {
      await postUnifiedReply(input.window.origin, text);
    },
  });
}

async function resolveInboundAnswer(
  input: {
    readonly window: UnifiedWindowWake;
    readonly auth: { attributes?: Record<string, unknown> };
    readonly internalDispatch?: true;
    readonly message?: unknown;
  },
  bareToken: string,
): Promise<UnifiedReceiveTarget["answer"] | undefined> {
  try {
    const org = deploymentOrg();
    let containerKey: string | undefined;
    try {
      containerKey = unifiedThreadRef(input.window.origin).channelKey;
    } catch {
      containerKey = undefined;
    }
    const roomText =
      typeof input.message !== "string" ? undefined : isWakeEnvelopeShaped(input.message) ? triggerMessageBody(input.message) : input.message;
    const readOwnedQuestion = async () => await readBridgedQuestion(getOperationalStore(), org, bareToken);
    const routing = await resolveInboundAnswerRouting(
      {
        internalDispatch: input.internalDispatch === true,
        ...(containerKey ? { containerKey } : {}),
        ...(roomText !== undefined ? { text: roomText } : {}),
        addressedMention: isAddressedMentionWake(input.window, bareToken),
      },
      {
        read: readOwnedQuestion,
        admit: async () => {
          const bindable = {
            channel: { kind: input.window.origin.platform },
            session: { auth: { current: input.auth } },
          } as unknown as BindableContext;
          const p = resolvePartition(bindable);
          return admitInputResponse({
            org: p.org,
            platform: p.platform,
            workspace: p.workspace,
            ...(p.surface === undefined ? {} : { surface: p.surface }),
            surfaceKey: p.surfaceKey,
            principalId: bindFrom(bindable).principalId ?? "",
            responses: 1,
          });
        },
      },
    );
    if (routing.kind === "wake") {
      if (routing.reason === "refused") {
        ulog(`REFUSED an answer to the outstanding question on ${bareToken} — delivering it as an ordinary wake, the question stays open`);
      } else if (routing.reason === "unmatched-option") {
        ulog(`the outstanding APPROVAL on ${bareToken} was not answered by this message (it names no option) — ordinary wake, the approval stays parked`);
      } else if (routing.reason === "addressed-mention") {
        ulog(`the outstanding question on ${bareToken} was not answered by this message (it @-mentions the agent) — ordinary wake, the question stays open`);
      } else if (routing.reason === "foreign-room") {
        ulog(`the outstanding question on ${bareToken} is showing in another room — this message is an ordinary wake, the question stays open`);
      }
      return undefined;
    }
    return {
      requestId: routing.requestId,
      floor: routing.floor,
      ...(routing.optionId !== undefined ? { optionId: routing.optionId } : {}),
    };
  } catch (err) {
    console.warn(`[open-everywhere:unified] inbound-answer decision skipped (${String(err)}) — delivering as an ordinary wake`);
    return undefined;
  }
}

type UnifiedFinalMessageHandler = NonNullable<ChannelEvents<void>["message.completed"]>;
type UnifiedTurnCompletedHandler = NonNullable<ChannelEvents<void>["turn.completed"]>;

const finalMessageHandled = defineState<string | null>("open-everywhere.unified.final-message-handled", () => null);

function markFinalMessageHandled(turnId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    finalMessageHandled.update(() => turnId);
  } catch {
  }
}

function finalMessageHandledFor(turnId: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    return finalMessageHandled.get() === turnId;
  } catch {
    return false;
  }
}

const onUnifiedFinalMessage: UnifiedFinalMessageHandler = async (data, channel, ctx) => {
  const sessionId = ctx?.session?.id;
  const finalBind = { session: ctx.session } as unknown as BindableContext;
  const finalTurnId = data.turnId ?? currentTurnId(finalBind);
  if (data.finishReason === "stop" && typeof data.message === "string" && data.message.length > 0) {
    const wakeForPending = currentWakeId(finalBind);
    const owing = wakeForPending === undefined ? undefined : pendingDelegationOwing(finalTurnId, wakeForPending, addressedWakeThisTurn(finalTurnId));
    if (owing !== undefined) {
      ulog(`pre-wait text (${data.message.length} chars) while worker task ${owing} still owes wake ${wakeForPending} — not this turn's final message; nothing posted, nothing re-driven`);
      return;
    }
  }
  const action = finalMessageActionForTurn(data.finishReason, data.message);
  if (action.kind === "buffer-tool-status") return;
  markFinalMessageHandled(finalTurnId);
  if (isWorkWindowToken(bareTokenFromEveContext(channel.continuation?.token))) {
    consumeRepliedThisTurn(finalTurnId);
    consumeReactedThisTurn();
    return;
  }
  const replied = consumeRepliedThisTurn(currentTurnId({ session: ctx.session } as unknown as BindableContext));
  const org = deploymentOrg();
  const { workspace, surface } = auditLabels(channel.continuation?.token);
  const accountingBind = { session: ctx.session } as unknown as BindableContext;
  const reacted = consumeReactedThisTurn();
  await auditUnaccountedWakesForTurn(
    org,
    workspace,
    surface,
    bareTokenFromEveContext(channel.continuation?.token),
    currentTurnId(accountingBind),
    currentWakeId(accountingBind),
    reacted,
  ).catch(() => undefined);
  if (action.kind === "silent") {
    const bind = { session: ctx.session } as unknown as BindableContext;
    const wakeId = currentWakeId(bind);
    const silentTurnId = currentTurnId(bind);
    const answeredThisWake = wakeId !== undefined && repliedWakesThisTurn(silentTurnId).includes(wakeId);
    const silentOrigin = !answeredThisWake && wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId).catch(() => null) : null;
    const answeredVia = silentOrigin ? await answeredContainerVia(org, silentTurnId, wakeId, silentOrigin) : undefined;
    const answeredContainer = answeredVia !== undefined;
    let linearClosed: boolean | undefined;
    if (silentOrigin) {
      try {
        if (await completeUnifiedSessionSilently(silentOrigin, {}, answeredContainer)) {
          linearClosed = true;
          ulog(`silent turn: closed the wake's open ${silentOrigin.platform} session without posting model prose (answered elsewhere in this container: ${answeredContainer})`);
        }
      } catch (err) {
        linearClosed = false;
        ulog(`silent turn: FAILED to close the open ${silentOrigin.platform} session (spinner may persist until timeout): ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      }
    }
    if (action.reason === NO_REPLY_SENTINEL_REASON) {
      await auditNoReplySentinelObserved({ org, platform: "unified", workspace, surface: surface ?? "unknown" }, sessionId, wakeId).catch(() => undefined);
    }
    if (isBareStop(action, replied || reacted)) {
      ulog(
        `BARE STOP — turn ended with no reply, no react and no no_reply (wake ${wakeId ?? "none"}) — ` +
          `this usually means a judgement went missing, not that one was made.`,
      );
      await appendAudit({
        org,
        platform: "unified",
        workspace,
        surface,
        action: "turn.bare_stop",
        detail: { wakeId: wakeId ?? null, ...(sessionId ? { sessionId } : {}) },
      }).catch(() => undefined);
    }
    if (auditSilencesEnabled()) {
      await appendAudit({
        org,
        platform: "unified",
        workspace,
        surface,
        action: "unified.no_reply",
        detail: { reason: action.reason, replied, wakeId: wakeId ?? null, ...(linearClosed !== undefined ? { linearClosed, answeredContainer, ...(answeredVia ? { answeredVia } : {}) } : {}), ...(sessionId ? { sessionId } : {}) },
      }).catch(() => undefined);
    }
    return;
  }
  const bind = { session: ctx.session } as unknown as BindableContext;
  const blockingRefusal = proseBlockingRefusal(refusalsForWakeThisTurn(currentTurnId(bind), currentWakeId(bind)));
  const proseCarriesSubstance = replyCarriesSubstance(action.text);
  const { addressing: addressingKind, reason: dropReason } = ambientProseDropDetail(
    currentTurnAddressing(bind),
    currentTurnAddressed(bind),
    replied,
    blockingRefusal,
    proseCarriesSubstance,
  );
  ulog(`message-tool-only: DROPPED terminal prose (${action.text.length} chars; replied=${replied}; addressing=${addressingKind}; reason=${dropReason}) — replies must come from the reply tool`);
  await appendAudit({
    org,
    platform: "unified",
    workspace,
    surface,
    action: "turn.supervisor_prose_dropped",
    detail: {
      chars: action.text.length,
      replied,
      addressing: addressingKind,
      reason: dropReason,
      wakeId: currentWakeId(bind) ?? null,
      ...(sessionId ? { sessionId } : {}),
    },
  }).catch(() => undefined);

  let redriven = false;
  if (proseDropMayRedrive({ replied, blockingRefusal, token: channel.continuation?.token, turnId: currentTurnId(bind) }) && channel.continuation?.token !== undefined) {
    const wakeId = currentWakeId(bind);
    const rawToken = channel.continuation.token;
    const domain = unifiedDomainFromToken(rawToken);
    const baseAttrs: Record<string, unknown> = { ...(bind.session?.auth?.current?.attributes ?? {}) };
    delete baseAttrs[OE_ADDRESSING_ATTR];
    const reinject: RedriveReinject = buildRedriveReinject(domain, rawToken, baseAttrs);
    const owesWorkerReport = refusalsForWakeThisTurn(currentTurnId(bind), wakeId).includes(DELEGATION_PENDING_REFUSAL_REASON);
    if (wakeId) carryRunRefusalsToRedrive(wakeId);
    const outcome = await maybeRedrive(
      { org, workspace, surface, ...(sessionId ? { sessionId } : {}), wakeId, chars: action.text.length, replied, owesWorkerReport },
      { store: getOperationalStore(), reinject },
    );
    if (outcome.status === "redriven") {
      ulog(`auto-redrive: re-injected a corrective wake for wake ${outcome.originalWakeId} (dropped ${action.text.length} chars) — one more turn to reply`);
    } else if (outcome.status !== "skip-replied") {
      if (wakeId) dropCarriedRunRefusals(wakeId);
      ulog(`auto-redrive: NOT fired (${outcome.status}) for wake ${outcome.originalWakeId ?? "none"} — drop is final`);
    }
    redriven = outcome.status === "redriven";
  }
  const dropWakeId = currentWakeId(bind);
  const answeredThisWake = dropWakeId !== undefined && repliedWakesThisTurn(currentTurnId(bind)).includes(dropWakeId);
  if (proseDropClosesWakeSession(answeredThisWake, redriven)) {
    const dropOrigin = dropWakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, dropWakeId).catch(() => null) : null;
    if (dropOrigin && postArm(dropOrigin.platform)?.closeUnifiedSilently) {
      try {
        const answered = (await answeredContainerVia(org, currentTurnId(bind), dropWakeId, dropOrigin)) !== undefined;
        if (await completeUnifiedSessionSilently(dropOrigin, {}, answered)) {
          ulog(`final prose drop: closed the wake's open ${dropOrigin.platform} session with the host ack (answered elsewhere in this container: ${answered})`);
        }
      } catch (err) {
        ulog(`final prose drop: FAILED to close the open ${dropOrigin.platform} session (spinner may persist until timeout): ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      }
    }
  }
};

const onUnifiedTurnCompleted: UnifiedTurnCompletedHandler = async (data, channel, ctx) => {
  const turnId = data.turnId ?? currentTurnId({ session: ctx.session } as unknown as BindableContext);
  if (finalMessageHandledFor(turnId)) return;
  await onUnifiedFinalMessage({ finishReason: "stop", message: "", sequence: data.sequence, stepIndex: 0, turnId }, channel, ctx);
};

const channel = defineChannel<undefined, void, UnifiedReceiveTarget>({
  routes: [
    GET("/eve/v1/unified", async () => new Response("not found", { status: 404 })),
    POST(SELF_DISPATCH_PATH, async (req, { to }) => handleSelfDispatch(req, to, (r, i) => divertToUnifiedWindow(r, { ...i, internalDispatch: true }))),
  ],
  kindHint: "unified",
  turnPolicy: "queue",
  async receive(input, { from }): Promise<Session> {
    const t = input.target as Partial<UnifiedReceiveTarget> | undefined;
    if (
      !t ||
      typeof t.token !== "string" ||
      !isUnifiedSupervisorToken(t.token) ||
      typeof t.wakeId !== "string" ||
      t.wakeId.length === 0 ||
      typeof t.surfaceKey !== "string" ||
      (t.authority !== undefined && !isUnifiedWakeAuthority(t.authority)) ||
      !isUnifiedWakeOrigin(t.origin) ||
      (t.answer !== undefined &&
        (typeof t.answer.requestId !== "string" ||
          t.answer.requestId.length === 0 ||
          typeof t.answer.floor !== "string" ||
          (t.answer.optionId !== undefined && (typeof t.answer.optionId !== "string" || t.answer.optionId.length === 0)) ||
          (t.answer.nonMember !== undefined && t.answer.nonMember !== true)))
    ) {
      throw new Error("unified receive: malformed target (host dispatch bug) — refusing the wake");
    }
    if (!windowEnabledFor(t.surfaceKey, t.token)) {
      throw new Error(`unified receive: no standing window is enabled for ${t.surfaceKey} — refusing the wake (fail-closed)`);
    }
    const org = deploymentOrg();
    const store = getOperationalStore();
    const existingAuthority = await resolveUnifiedWakeAuthority(store, org, t.wakeId);
    const authority = existingAuthority
      ? {
          binding: existingAuthority.binding,
          requester: existingAuthority.requester,
          nonMemberWake: existingAuthority.nonMemberWake,
        }
      : t.authority;
    await registerUnifiedWakeTarget(store, org, t.wakeId, t.origin, new Date().toISOString(), t.token, t.inbound === true, t.addressing, t.surfaceKey, authority?.binding, authority);
    ulog(`wake ${t.wakeId} from ${t.surfaceKey} → ${t.token} (origin ${t.origin.platform})`);
    await drainGenerationRetirements(from, { org, incomingToken: t.token }, { labelsFor: auditLabels });
    const answerText = typeof input.message === "string" ? input.message : undefined;
    if (t.answer) {
      const bare = bareTokenFromEveContext(t.token) ?? t.token;
      const answerDetail = {
        requestId: t.answer.requestId,
        floor: t.answer.floor,
        wakeId: t.wakeId,
        chars: answerText?.length ?? 0,
        surfaceKey: t.surfaceKey,
        ...(t.answer.optionId !== undefined ? { optionId: t.answer.optionId } : {}),
        ...(t.answer.nonMember === true ? { nonMember: true } : {}),
      };
      const { workspace: answerWorkspace, surface: answerSurface } = auditLabels(t.token);
      try {
        if (answerText === undefined) throw new Error("the delivery is structured content, not text — an answer must be text");
        if (t.answer.nonMember === true && !(await rememberNonMemberAnswer(getOperationalStore(), org, t.answer.requestId))) {
          throw new Error("the answerer is a non-member and the stamp could not be recorded — an unmarked guest answer is never delivered");
        }
        const session = await from(t.token).respond([{ requestId: t.answer.requestId, text: answerText, ...(t.answer.optionId ? { optionId: t.answer.optionId } : {}) }], {
          ...(t.context && t.context.length > 0 ? { context: [...t.context] } : {}),
        } as { auth: typeof input.auth; context?: string[] });
        await forgetBridgedQuestion(getOperationalStore(), org, bare);
        await settleAnsweredWake(getOperationalStore(), org, t.wakeId);
        ulog(`answer ${t.answer.requestId} delivered to ${t.token} (floor ${t.answer.floor})`);
        await appendAudit({
          org,
          platform: "unified",
          workspace: answerWorkspace,
          surface: answerSurface,
          action: QUESTION_ANSWERED_AUDIT_ACTION,
          detail: answerDetail,
        }).catch(() => undefined);
        return session;
      } catch (err) {
        if (isRateLimitThrow(err)) throw err;
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        console.warn(`[open-everywhere:unified] answer ${t.answer.requestId} could NOT be delivered (${error}) — falling back to an ordinary wake, the question stays open`);
        await appendAudit({
          org,
          platform: "unified",
          workspace: answerWorkspace,
          surface: answerSurface,
          action: QUESTION_ANSWER_DROPPED_AUDIT_ACTION,
          detail: { ...answerDetail, error },
        }).catch(() => undefined);
      }
    }
    const questionMayBeOpen = await bridgedQuestionMayBeOpen(store, org, bareTokenFromEveContext(t.token) ?? t.token);
    return from(t.token).send(input.message, {
      auth: completeWakeAuth(input.auth),
      ...(t.context && t.context.length > 0 ? { context: [...t.context] } : {}),
      ...(isWorkWindowToken(t.token) ? { turnPolicy: "steer" as const } : {}),
      ...ordinaryWakeSendOptions(questionMayBeOpen),
    });
  },
  events: {
    "message.completed": onUnifiedFinalMessage,
    "turn.completed": onUnifiedTurnCompleted,
    async "input.requested"(data, channel, ctx) {
      try {
        const question = detectBridgeableInputRequest((data as { requests?: unknown } | undefined)?.requests);
        if (!question) return;
        const org = deploymentOrg();
        const { workspace, surface } = auditLabels(channel.continuation?.token);
        const bind = { session: ctx?.session } as unknown as BindableContext;
        const sessionId = typeof ctx?.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
        const rawTaskId = (data as { taskId?: unknown } | undefined)?.taskId;
        const taskId = typeof rawTaskId === "string" && rawTaskId.length > 0 ? rawTaskId : undefined;
        const workBare = bareTokenFromEveContext(channel.continuation?.token);
        if (workBare !== undefined && isWorkWindowToken(workBare)) {
          ulog(`question from task ${taskId ?? "(none)"} on a work session NOT bridged: a work-session child asks with ask_room (OPE-2340)`);
          await appendAudit({
            org,
            platform: "unified",
            workspace,
            surface,
            action: QUESTION_DROPPED_AUDIT_ACTION,
            detail: { reason: "work-session", requestId: question.requestId, ...(taskId ? { taskId } : {}) },
          }).catch(() => undefined);
          return;
        }
        const wakeId = currentWakeId(bind);
        const bare = bareTokenFromEveContext(channel.continuation?.token);
        const cardTicket = mintApprovalCardTicket();
        let cardActionCount = 0;
        const outcome = await bridgeQuestionToSurface(
          { org, platform: "unified", workspace, surface, ...(sessionId ? { sessionId } : {}), ...(wakeId ? { wakeId } : {}) },
          question,
          {
            resolveOrigin: async () => (wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId).catch(() => null) : null),
            post: async (origin, text) => {
              const actions = canPostUnifiedActions(origin.platform) ? approvalCardActions(question, cardTicket) : [];
              if (actions.length > 0 && sessionId === undefined) {
                console.warn(`[open-everywhere:unified] question bridge: the turn names no session id — posting ${question.toolName} as TEXT, because a tap would have nowhere to deliver`);
              }
              if (actions.length === 0 || bare === undefined || sessionId === undefined) return postUnifiedReply(origin, text);
              let cardContainerKey: string | undefined;
              try {
                cardContainerKey = unifiedThreadRef(origin).channelKey;
              } catch {
                cardContainerKey = undefined;
              }
              const stored = await rememberApprovalCardTicket(getOperationalStore(), org, cardTicket, {
                sessionId,
                bareToken: bare,
                ...(cardContainerKey ? { containerKey: cardContainerKey } : {}),
                requestId: question.requestId,
                optionIds: approvalOptionIds(question),
              });
              if (!stored) return postUnifiedReply(origin, text);
              cardActionCount = actions.length;
              return postUnifiedReply(origin, text, {}, undefined, undefined, undefined, actions);
            },
          },
        );
        if (outcome.status === "bridged") {
          let containerKey: string | undefined;
          try {
            containerKey = unifiedThreadRef(outcome.origin).channelKey;
          } catch {
            containerKey = undefined;
          }
          const remembered =
            bare === undefined
              ? false
              : await rememberBridgedQuestion(getOperationalStore(), org, bare, {
                  requestId: question.requestId,
                  ...(containerKey ? { containerKey } : {}),
                  ...(wakeId ? { wakeId } : {}),
                  optionIds: approvalOptionIds(question),
                });
          ulog(
            `question bridge: posted ${question.toolName} (${question.kind}) to ${outcome.platform} for wake ${wakeId ?? "none"} — id ${outcome.id}` +
              (cardActionCount > 0 ? ` (card: ${cardActionCount} button(s))` : " (text only)") +
              (remembered && containerKey
                ? ` (answerable from ${containerKey}: ${question.requestId})`
                : " (NOT answerable — no outstanding-question row, or no room to bind it to)"),
          );
        } else {
          console.warn(
            `[open-everywhere:unified] question bridge: DROPPED ${question.toolName} (${outcome.reason}) for wake ${wakeId ?? "none"} — the session is parked on a question the room cannot see (audited)`,
          );
        }
      } catch (err) {
        console.warn(`[open-everywhere:unified] question bridge skipped: ${String(err)}`);
      }
    },
    async "turn.failed"(data, channel) {
      const { workspace, surface } = auditLabels(channel.continuation?.token);
      ulog(`supervisor turn failed on domain ${workspace} (audited, nothing posted): ${data.message}`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "unified",
        workspace,
        surface,
        action: "unified.supervisor_turn_failed",
        detail: {
          message: String(data.message).slice(0, 500),
          ...failureDiag(data.code, data.details),
          ...unresumableAuditDetail(data.message, data.code),
        },
      }).catch(() => undefined);
    },
    async "session.failed"(data, channel) {
      const { workspace, surface } = auditLabels(channel.continuation?.token);
      ulog(`supervisor session failed on domain ${workspace} (audited, nothing posted): ${data.message}`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "unified",
        workspace,
        surface,
        action: "unified.supervisor_session_failed",
        detail: {
          message: String(data.message).slice(0, 500),
          ...failureDiag(data.code, data.details),
          ...unresumableAuditDetail(data.message, data.code),
        },
      }).catch(() => undefined);
    },
  },
});

export default channel;

export async function divertToUnifiedWindow(
  receive: RouteHandlerArgs["to"],
  input: {
    readonly message: string;
    readonly context?: readonly string[];
    readonly token: string;
    readonly window: UnifiedWindowWake;
    readonly surfaceKey: string;
    readonly auth: { attributes?: Record<string, unknown> };
    readonly binding?: SurfaceBinding;
    readonly internalDispatch?: true;
  },
): Promise<void> {
  const ingressMs = Date.now();
  if (!admitInboundSurface(input.window.origin.platform)) {
    ulog(`REFUSED inbound wake from unselected provider "${input.window.origin.platform}" (audited, not delivered)`);
    await appendAudit({
      org: deploymentOrg(),
      platform: input.window.origin.platform,
      workspace: parseWindowToken(input.token.startsWith("unified:") ? input.token.slice("unified:".length) : input.token)?.domain ?? "unknown",
      surface: input.surfaceKey,
      action: "provider.unselected_wake_refused",
      detail: { wakeId: input.window.wakeId, selected: [...(providerSelection() ?? [])] },
    }).catch(() => undefined);
    return;
  }
  if (input.binding !== undefined) {
    if (
      !isFrozenSurfaceBinding(input.binding) ||
      input.binding.org !== deploymentOrg() ||
      !wakeBindingMatchesSurfaceKey(input.binding, input.surfaceKey) ||
      !wakeBindingMatchesOrigin(input.binding, input.window.origin)
    ) {
      throw new Error("unified continuation binding does not match its durable origin");
    }
  }
  if (input.internalDispatch !== true && (await windowSpendGate(input)) === "declined") {
    ulog(`DECLINED single-window wake ${input.window.wakeId} from ${input.surfaceKey} — over its spend cap (refusal posted, no model turn)`);
    return;
  }
  rememberUnifiedReceive(receive);
  const sources = windowSourcesForDivert(input.token, input.window.origin.platform);
  const bareToken = input.token.startsWith("unified:") ? input.token.slice("unified:".length) : input.token;
  const replyAnchor = unifiedPlacementRef(input.window.origin);
  const deliveryId = mintWakeId();
  const authorityAttributes: Record<string, unknown> = { ...(input.auth.attributes ?? {}) };
  delete authorityAttributes[OE_FROZEN_SURFACE_BINDING_ATTR];
  if (input.binding !== undefined) authorityAttributes[OE_FROZEN_SURFACE_BINDING_ATTR] = JSON.stringify(input.binding);
  const authorityAuth = { ...input.auth, attributes: authorityAttributes };
  const auth = stampUnifiedWindowAuth(authorityAuth, input.window.origin.platform, input.window.wakeId, input.window.addressing, sources, bareToken, replyAnchor, deliveryId);
  const bindingContext: BindableContext = { channel: { kind: "unified" }, session: { auth: { current: auth as never } } };
  const binding = input.binding ?? (carriesPlatformIdentity(bindingContext) ? bindFrom(bindingContext) : undefined);
  try {
    if (input.internalDispatch !== true) {
      await appendAudit({
        org: deploymentOrg(),
        platform: input.window.origin.platform,
        workspace: parseWindowToken(bareToken)?.domain ?? "unknown",
        surface: input.surfaceKey,
        action: WAKE_INGRESS_ACTION,
        ts: new Date(ingressMs).toISOString(),
        detail: wakeIngressDetail({
          wakeId: input.window.wakeId,
          deliveryId,
          surfaceKey: input.surfaceKey,
          ...(input.window.vendorTs ? { vendor: input.window.vendorTs } : {}),
          ingressMs,
        }),
      });
    }
  } catch {
  }
  const answer = await resolveInboundAnswer(input, bareToken);
  const target: UnifiedReceiveTarget = {
    token: input.token,
    wakeId: input.window.wakeId,
    origin: input.window.origin,
    ...(binding
      ? {
          authority: {
            binding,
            requester: requesterVerdictFor({
              text: input.message,
              seat: input.internalDispatch === true ? "worker" : "room",
              inherited: authString(authorityAttributes[OE_REQUESTER_ATTR]),
              inheritedCandidates: authString(authorityAttributes[OE_REQUESTER_CANDIDATES_ATTR]),
            }),
            nonMemberWake: authString(authorityAttributes[OE_CHAT_NONMEMBER_ATTR]) === "true",
          },
        }
      : {}),
    ...(answer ? { answer: authString(authorityAttributes[OE_CHAT_NONMEMBER_ATTR]) === "true" ? { ...answer, nonMember: true as const } : answer } : {}),
    surfaceKey: input.surfaceKey,
    inbound: input.internalDispatch !== true,
    ...(input.window.addressing ? { addressing: input.window.addressing } : {}),
    ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
  };
  const message = input.message;
  const deliveredAuth = auth;
  try {
    await withRetryAfterThrown(() => receive(channel, target).send(message, { auth: completeWakeAuth(deliveredAuth) }), {
      surface: input.window.origin.platform,
      operation: WAKE_DISPATCH_OPERATION,
      ...WAKE_DISPATCH_RETRY_POLICY,
      onRefusal: (refusal) =>
        appendAudit({
          org: deploymentOrg(),
          platform: input.window.origin.platform,
          workspace: parseWindowToken(bareToken)?.domain ?? "unknown",
          surface: input.surfaceKey,
          action: WAKE_RETRY_ACTION,
          detail: wakeRetryDetail({
            wakeId: input.window.wakeId,
            deliveryId,
            surfaceKey: input.surfaceKey,
            attempt: refusal.attempt,
            delayMs: refusal.delayMs,
            waitedMs: refusal.waitedMs,
            outcome: refusal.outcome,
            refusalStatus: refusal.refusalStatus,
          }),
        }).catch(() => undefined),
    });
  } catch (err) {
    await healPrunedDeploymentStrand({
      token: bareToken,
      surfaceKey: input.surfaceKey,
      platform: input.window.origin.platform,
      atIso: new Date().toISOString(),
      err,
    });
    throw err;
  }
}

export function bindingForDivert(input: {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly origin: UnifiedWakeOrigin;
  readonly wakeId: string;
  readonly token: string;
}): SurfaceBinding | undefined {
  const bareToken = input.token.startsWith("unified:") ? input.token.slice("unified:".length) : input.token;
  const attributes: Record<string, unknown> = { ...input.attributes };
  delete attributes[OE_FROZEN_SURFACE_BINDING_ATTR];
  const auth = stampUnifiedWindowAuth(
    { attributes },
    input.origin.platform,
    input.wakeId,
    "direct-mention",
    windowSourcesForDivert(input.token, input.origin.platform),
    bareToken,
    unifiedPlacementRef(input.origin),
    mintWakeId(),
  );
  const ctx: BindableContext = { channel: { kind: "unified" }, session: { auth: { current: auth as never } } };
  return carriesPlatformIdentity(ctx) ? bindFrom(ctx) : undefined;
}

export async function divertInboundToUnifiedWindow(
  receive: RouteHandlerArgs["to"],
  input: {
    readonly message: string;
    readonly context?: readonly string[];
    readonly token: string;
    readonly window: UnifiedWindowWake;
    readonly surfaceKey: string;
    readonly auth: { attributes?: Record<string, unknown> };
  },
): Promise<void> {
  if (!oneshotAgentEnabled()) return divertToUnifiedWindow(receive, input);
  const standing = parseWindowToken(input.token);
  if (!standing || isTaskWindowId(standing.windowId) || isThreadSeatWindowId(standing.windowId)) {
    return divertToUnifiedWindow(receive, input);
  }
  if (!isThreadScopedWakeOrigin(input.window.origin)) {
    return divertToUnifiedWindow(receive, input);
  }
  const org = deploymentOrg();
  const store = getOperationalStore();
  const ref = unifiedThreadRef(input.window.origin);
  const owner = await resolveThreadOwner(store, org, ref);
  const route = routeThreadMessage(owner, standing.generation, standing.domain);
  const audit = (detail: Record<string, unknown>) =>
    appendAudit({
      org,
      platform: "unified",
      workspace: standing.domain,
      action: "thread.ingress_routed",
      detail: { wakeId: input.window.wakeId, channelKey: ref.channelKey, threadKey: ref.threadKey, surfaceKey: input.surfaceKey, ...detail },
    }).catch(() => undefined);
  if (route.kind !== "task") {
    if (owner !== null) {
      const reaped = await clearThreadOwner(store, org, ref);
      await audit({ routed: "standing", reason: "stale-owner", ownerId: owner, reaped });
    }
    return divertToUnifiedWindow(receive, input);
  }
  const attributes: Record<string, unknown> = { ...(input.auth.attributes ?? {}), [OE_GRAIN_ATTR]: route.grain };
  try {
    await divertToUnifiedWindow(receive, { ...input, token: route.token, auth: { ...input.auth, attributes } });
  } catch (err) {
    if (err instanceof RateLimitExhaustedError) {
      await audit({ routed: "none", reason: "owner-divert-rate-limited", ownerId: route.token, grain: route.grain, attempts: err.attempts, waitedMs: err.waitedMs });
      throw err;
    }
    const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await audit({ routed: "standing", reason: "owner-divert-failed", ownerId: route.token, grain: route.grain, error: errMsg });
    return divertToUnifiedWindow(receive, input);
  }
  await audit({ routed: "owner", ownerId: route.token, grain: route.grain });
}

export function buildRedriveReinject(domain: string | undefined, rawToken: string, baseAttrs: Record<string, unknown>): RedriveReinject {
  if (!crossProcessDispatchAvailable()) return null;
  const seatWindowId = parseWindowToken(rawToken)?.windowId;
  return async (origin, message, originalWakeId) => {
    const surfaceKey = pickRedriveSurfaceKey(domain, origin.platform, seatWindowId);
    if (!surfaceKey) throw new Error(`unified redrive: no crossSurfaceWindow surface key for domain ${domain ?? "?"}`);
    await deliverUnifiedDispatch({
      message,
      token: rawToken,
      window: { wakeId: originalWakeId, origin },
      surfaceKey,
      auth: { attributes: baseAttrs },
    });
  };
}

export const OE_SPAWN_TAINTED_ATTR = "oe_spawn_tainted";

export const OE_SPAWN_TAINT_KINDS_ATTR = "oe_spawn_taint_kinds";

function taintKindsAttrValue(tainted: boolean, kinds: readonly string[] | undefined): string | undefined {
  if (!tainted || kinds === undefined) return undefined;
  const named = [...new Set(kinds.filter((k) => (INGESTION_KINDS as readonly string[]).includes(k)))];
  return named.length > 0 ? named.join(",") : undefined;
}

export async function dispatchTaskWindow(input: {
  readonly token: string;
  readonly message: string;
  readonly wakeId: string;
  readonly domain: string;
  readonly origin: UnifiedWakeOrigin;
  readonly parentAuthAttributes?: Record<string, unknown>;
  readonly tainted: boolean;
  readonly grain?: "task" | "thread";
  readonly taskLabel?: string;
  readonly turnId?: string;
  readonly seatWindowId?: string;
}): Promise<void> {
  if (!crossProcessDispatchAvailable()) {
    throw new Error(
      "dispatchTaskWindow: no live cross-surface dispatch is available on this instance — this process has handled no surface webhook (no captured cross-channel dispatch) and the self-dispatch route is not configured (arm OE_CREDENTIAL_ENCRYPTION_KEY; plus OE_PUBLIC_BASE_URL when the deployment's own URL isn't discoverable). Retry from a message-driven turn.",
    );
  }
  const surfaceKey = pickRedriveSurfaceKey(input.domain, input.origin.platform, input.seatWindowId);
  if (!surfaceKey) {
    throw new Error(`dispatchTaskWindow: couldn't resolve a window-enabled surface for domain "${input.domain}" — the task cannot be dispatched.`);
  }
  const attributes: Record<string, unknown> = { ...(input.parentAuthAttributes ?? {}) };
  attributes[OE_GRAIN_ATTR] = input.grain ?? "task";
  if (input.taskLabel) attributes[OE_TASK_LABEL_ATTR] = input.taskLabel;
  attributes[INVOKER_POSTURE_ATTR] = currentInvokerPosture();
  attributes[OE_REQUESTER_ATTR] = requesterStampForDispatch(input.turnId);
  const requesterCandidates = requesterCandidatesStampForDispatch(input.turnId);
  if (requesterCandidates !== undefined) attributes[OE_REQUESTER_CANDIDATES_ATTR] = requesterCandidates;
  else delete attributes[OE_REQUESTER_CANDIDATES_ATTR];
  if (input.tainted) attributes[OE_SPAWN_TAINTED_ATTR] = "true";
  await deliverUnifiedDispatch({
    message: input.message,
    token: input.token,
    window: { wakeId: input.wakeId, origin: input.origin, addressing: "direct-mention" },
    surfaceKey,
    auth: { attributes },
  });
}

export async function dispatchApprovalDecisionWake(input: {
  readonly token: string;
  readonly origin: UnifiedWakeOrigin;
  readonly wakeId: string;
  readonly message: string;
  readonly domain: string;
  readonly binding?: SurfaceBinding;
  readonly requester?: RequesterVerdict;
  readonly nonMemberWake?: boolean;
  readonly authAttributes?: Record<string, unknown>;
}): Promise<boolean> {
  if (input.binding === undefined || input.requester === undefined) return false;
  const attributes: Record<string, unknown> = { ...(input.authAttributes ?? {}) };
  if (input.requester !== undefined) {
    attributes[OE_REQUESTER_ATTR] = input.requester.kind === "requester" ? input.requester.principalId : REQUESTER_UNVERIFIED;
    if (input.requester.kind === "unverified" && input.requester.candidates !== undefined) {
      attributes[OE_REQUESTER_CANDIDATES_ATTR] = JSON.stringify(input.requester.candidates);
    } else {
      delete attributes[OE_REQUESTER_CANDIDATES_ATTR];
    }
  }
  if (input.nonMemberWake === true) attributes[OE_CHAT_NONMEMBER_ATTR] = "true";
  else delete attributes[OE_CHAT_NONMEMBER_ATTR];
  return dispatchAmbientSeatWake({ ...input, authAttributes: attributes });
}

async function dispatchAmbientSeatWake(input: {
  readonly token: string;
  readonly origin: UnifiedWakeOrigin;
  readonly wakeId: string;
  readonly message: string;
  readonly domain: string;
  readonly binding?: SurfaceBinding;
  readonly authAttributes?: Record<string, unknown>;
}): Promise<boolean> {
  if (!crossProcessDispatchAvailable()) return false;
  const surfaceKey = input.binding
    ? `${input.binding.platform}/${input.binding.workspace}/${input.binding.domainSurface ?? input.binding.surface}`
    : pickRedriveSurfaceKey(input.domain, input.origin.platform, parseWindowToken(input.token)?.windowId);
  if (!surfaceKey) return false;
  try {
    await deliverUnifiedDispatch({
      message: input.message,
      token: input.token,
      window: { wakeId: input.wakeId, origin: input.origin },
      surfaceKey,
      auth: { attributes: input.authAttributes ?? {} },
      ...(input.binding ? { binding: input.binding } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

export async function dispatchSeatMessage(input: {
  readonly token: string;
  readonly origin: UnifiedWakeOrigin;
  readonly wakeId: string;
  readonly message: string;
  readonly domain: string;
  readonly authAttributes?: Record<string, unknown>;
}): Promise<boolean> {
  return dispatchAmbientSeatWake(input);
}

export async function dispatchWorkRequest(input: {
  readonly token: string;
  readonly requestId: string;
  readonly message: string;
  readonly origin: UnifiedWakeOrigin;
  readonly surfaceKey: string;
  readonly binding: SurfaceBinding;
  readonly requester: RequesterVerdict;
  readonly nonMemberWake: boolean;
  readonly seatSessionId?: string;
  readonly seatWakeId: string;
  readonly cancel?: boolean;
  readonly tainted: boolean;
  readonly taintKinds?: readonly string[];
  readonly invokerPosture?: InvokerPosture;
  readonly identity?: Readonly<Record<string, string | readonly string[]>>;
  readonly ownAccountAsk?: string;
  readonly fireAttributes?: Readonly<Record<string, unknown>>;
}, receive?: RouteHandlerArgs["to"]): Promise<void> {
  if (receive === undefined && !crossProcessDispatchAvailable()) {
    throw new Error("work: no live cross-surface dispatch is available on this instance, so the job could not be forwarded. Retry from a message-driven turn.");
  }
  const attributes: Record<string, unknown> = {
    ...(input.fireAttributes ?? {}),
    ...(input.identity ?? {}),
    [OE_GRAIN_ATTR]: "standing",
    ...(input.cancel === true ? {} : { [OE_WORK_REQUEST_ATTR]: input.requestId }),
    [OE_REQUESTER_ATTR]: input.requester.kind === "requester" ? input.requester.principalId : REQUESTER_UNVERIFIED,
    [INVOKER_POSTURE_ATTR]: input.invokerPosture === undefined ? currentInvokerPosture() : narrowerInvokerPosture(input.invokerPosture, currentInvokerPosture()),
  };
  if (input.requester.kind === "unverified" && input.requester.candidates !== undefined) {
    attributes[OE_REQUESTER_CANDIDATES_ATTR] = JSON.stringify(input.requester.candidates);
  } else {
    delete attributes[OE_REQUESTER_CANDIDATES_ATTR];
  }
  if (input.nonMemberWake) attributes[OE_CHAT_NONMEMBER_ATTR] = "true";
  else delete attributes[OE_CHAT_NONMEMBER_ATTR];
  if (input.seatSessionId !== undefined) attributes[OE_WORK_SEAT_SESSION_ATTR] = input.seatSessionId;
  else delete attributes[OE_WORK_SEAT_SESSION_ATTR];
  attributes[OE_WORK_SEAT_WAKE_ATTR] = input.seatWakeId;
  if (input.tainted) attributes[OE_SPAWN_TAINTED_ATTR] = "true";
  const forwardKinds = taintKindsAttrValue(input.tainted, input.taintKinds);
  if (forwardKinds !== undefined) attributes[OE_SPAWN_TAINT_KINDS_ATTR] = forwardKinds;
  if (input.ownAccountAsk !== undefined && input.ownAccountAsk.length > 0) attributes[OE_OWN_ACCOUNT_ASK_ATTR] = input.ownAccountAsk;
  const payload = {
    message: input.message,
    token: input.token,
    window: { wakeId: input.requestId, origin: input.origin, addressing: "direct-mention" as const },
    surfaceKey: input.surfaceKey,
    auth: { attributes },
    binding: input.binding,
  };
  if (receive !== undefined) await divertToUnifiedWindow(receive, { ...payload, internalDispatch: true });
  else await deliverUnifiedDispatch(payload);
}

export function workResultAttributes(input: {
  readonly requestId: string;
  readonly requester: RequesterVerdict;
  readonly nonMemberWake: boolean;
  readonly tainted: boolean;
  readonly taintKinds?: readonly string[];
  readonly readsToken?: string;
  readonly invokerPosture?: InvokerPosture;
  readonly fireCreator?: string;
  readonly memoryWrites?: readonly DurableMemoryWrite[];
  readonly reportOwed?: boolean;
}): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    [OE_WORK_RESULT_ATTR]: input.requestId,
    [OE_REQUESTER_ATTR]: input.requester.kind === "requester" ? input.requester.principalId : REQUESTER_UNVERIFIED,
    ...(input.invokerPosture !== undefined ? { [INVOKER_POSTURE_ATTR]: input.invokerPosture } : {}),
    ...(input.fireCreator !== undefined ? { [WORK_FIRE_CREATOR_ATTR]: input.fireCreator } : {}),
  };
  if (input.requester.kind === "unverified" && input.requester.candidates !== undefined) {
    attributes[OE_REQUESTER_CANDIDATES_ATTR] = JSON.stringify(input.requester.candidates);
  }
  if (input.nonMemberWake) attributes[OE_CHAT_NONMEMBER_ATTR] = "true";
  if (input.tainted) attributes[OE_SPAWN_TAINTED_ATTR] = "true";
  const resultKinds = taintKindsAttrValue(input.tainted, input.taintKinds);
  if (resultKinds !== undefined) attributes[OE_SPAWN_TAINT_KINDS_ATTR] = resultKinds;
  if (input.readsToken !== undefined) attributes[OE_WORK_RESULT_READS_ATTR] = input.readsToken;
  if (input.reportOwed === true) attributes[OE_WORK_RESULT_OWED_ATTR] = "true";
  const writes = input.memoryWrites === undefined ? undefined : encodeCarriedWrites(input.memoryWrites);
  if (writes !== undefined) attributes[OE_WORK_RESULT_WRITES_ATTR] = writes;
  return attributes;
}

export async function dispatchWorkResult(input: {
  readonly seatToken: string;
  readonly wakeId: string;
  readonly message: string;
  readonly context?: readonly string[];
  readonly origin: UnifiedWakeOrigin;
  readonly surfaceKey: string;
  readonly binding: SurfaceBinding;
  readonly requester: RequesterVerdict;
  readonly nonMemberWake: boolean;
  readonly requestId: string;
  readonly tainted: boolean;
  readonly taintKinds?: readonly string[];
  readonly readsToken?: string;
  readonly invokerPosture?: InvokerPosture;
  readonly fireCreator?: string;
  readonly memoryWrites?: readonly DurableMemoryWrite[];
  readonly reportOwed?: boolean;
}): Promise<boolean> {
  if (!crossProcessDispatchAvailable()) return false;
  const attributes = workResultAttributes(input);
  try {
    await deliverUnifiedDispatch({
      message: input.message,
      token: input.seatToken,
      window: { wakeId: input.wakeId, origin: input.origin, addressing: "direct-mention" },
      surfaceKey: input.surfaceKey,
      auth: { attributes },
      binding: input.binding,
      ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
    });
    return true;
  } catch (err) {
    ulog(`work result wake for request ${input.requestId} could NOT be delivered: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    return false;
  }
}
