import { defineChannel, GET, POST } from "eve/channels";
import type { Session, RouteHandlerArgs } from "eve/channels";
import { SELF_DISPATCH_PATH, handleSelfDispatch, postSelfDispatch, selfDispatchConfigured, type UnifiedDispatchPayload } from "./self-dispatch.js";
import { appendAudit, auditSilencesEnabled } from "../audit/audit.js";
import { deploymentOrg, currentWakeId, currentTurnId, currentTurnAddressing, currentTurnAddressed, authPrincipalId, attestedFireCreatorId, bindFrom, windowGrainOf, windowTaskLabelOf, type BindableContext } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { windowedSupervisorEnabled, domainRoster } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { registerUnifiedWakeTarget, resolveUnifiedWakeTarget, isUnifiedWakeOrigin, mintWakeId, stampUnifiedWindowAuth, shouldBridgeAddressedProse, bridgeBlockingRefusal, unifiedThreadRef, sameUnifiedContainer, isThreadScopedWakeOrigin, OE_ADDRESSING_ATTR, OE_GRAIN_ATTR, OE_TASK_LABEL_ATTR, type UnifiedWakeOrigin, type UnifiedWindowWake } from "./unified-window.js";
import { postUnifiedReply, completeUnifiedSessionSilently } from "./unified-reply.js";
import { containerAnsweredSince } from "./answered-container-ledger.js";
import { isWakeEnvelopeShaped, triggerMessageBody } from "./wake-envelope.js";
import {
  detectBridgeableInputRequest,
  bridgeQuestionToSurface,
  forgetBridgedQuestion,
  readBridgedQuestion,
  rememberBridgedQuestion,
  resolveInboundAnswerRouting,
  approvalOptionIds,
  QUESTION_ANSWERED_AUDIT_ACTION,
  QUESTION_ANSWER_DROPPED_AUDIT_ACTION,
} from "./question-bridge.js";
import { admitInputResponse } from "../approvals/input-response-floor.js";
import { resolvePartition } from "../memory/partition.js";
import { unifiedDomainFromToken, unifiedDomainSessionKey, isUnifiedSupervisorToken } from "./unified-supervisor.js";
import { parseWindowToken, isTaskWindowId, isThreadSeatWindowId, isThreadSeatWindowToken, dmAnchorSurfaceForToken, dmSurfaceKeyFromAnchorDomain, bareTokenFromEveContext } from "./window-key.js";
import { resolveThreadOwner, clearThreadOwner, routeThreadMessage } from "./thread-ownership.js";
import { drainGenerationRetirements } from "./generation-retirement.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { INVOKER_POSTURE_ATTR } from "../access/invoker-posture.js";
import { currentInvokerPosture } from "../access/invoker-posture-state.js";
import {
  OE_REQUESTER_ATTR,
  OE_REQUESTER_CANDIDATES_ATTR,
  requesterCandidatesStampForDispatch,
  requesterStampForDispatch,
} from "../access/requester-identity.js";
import { addressedWakeThisTurn } from "../access/dispatch-origin-signal.js";
import { pendingDelegationOwing, BRIDGE_WAKE_HELD_AUDIT_ACTION } from "../access/pending-delegation-signal.js";
import { sourcesForWindow, windowSourcesNeedConfig } from "./window-sources.js";
import { finalMessageActionForTurn, isBareStop, replierLabelFor, NO_REPLY_SENTINEL_REASON } from "./turn-delivery.js";
import { withRunRefusalBlock } from "../routines/report.js";
import { consumeRoutineRunPermissionRefusals } from "../approvals/card-signal.js";
import { auditNoReplySentinelObserved } from "./chat-turn-audit.js";
import { consumeRepliedThisTurn, repliedWakesThisTurn, declinedWakesThisTurn, refusalsForWakeThisTurn } from "./reply-signal.js";
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

function pickRedriveSurfaceKey(domain: string | undefined, platform: string): string | null {
  if (!domain) return null;
  const dmSurface = dmSurfaceKeyFromAnchorDomain(domain);
  if (dmSurface) return dmSurface;
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
  readonly context?: readonly string[];
  readonly answer?: {
    readonly requestId: string;
    readonly floor: string;
    readonly taskId?: string;
    readonly optionId?: string;
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
): { readonly addressing: string; readonly reason: string } {
  return {
    addressing: rawAddressing ?? (addressed ? "addressed-other" : "ambient"),
    reason: replied ? "narration-after-reply" : blockingRefusal !== undefined ? `refused:${blockingRefusal}` : "no-reply-call",
  };
}

export async function answeredSameContainerThisTurn(org: string, turnId: string | undefined, wakeId: string | undefined, origin: UnifiedWakeOrigin): Promise<boolean> {
  const replied = repliedWakesThisTurn(turnId).filter((w) => w !== wakeId);
  if (replied.length === 0) return false;
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
    const routing = await resolveInboundAnswerRouting(
      {
        internalDispatch: input.internalDispatch === true,
        ...(containerKey ? { containerKey } : {}),
        ...(roomText !== undefined ? { text: roomText } : {}),
      },
      {
        read: () => readBridgedQuestion(getOperationalStore(), org, bareToken),
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
      } else if (routing.reason === "foreign-room") {
        ulog(`the outstanding question on ${bareToken} is showing in another room — this message is an ordinary wake, the question stays open`);
      }
      return undefined;
    }
    return {
      requestId: routing.requestId,
      floor: routing.floor,
      ...(routing.taskId !== undefined ? { taskId: routing.taskId } : {}),
      ...(routing.optionId !== undefined ? { optionId: routing.optionId } : {}),
    };
  } catch (err) {
    console.warn(`[open-everywhere:unified] inbound-answer decision skipped (${String(err)}) — delivering as an ordinary wake`);
    return undefined;
  }
}

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
      !isUnifiedWakeOrigin(t.origin) ||
      (t.answer !== undefined &&
        (typeof t.answer.requestId !== "string" ||
          t.answer.requestId.length === 0 ||
          typeof t.answer.floor !== "string" ||
          (t.answer.optionId !== undefined && (typeof t.answer.optionId !== "string" || t.answer.optionId.length === 0))))
    ) {
      throw new Error("unified receive: malformed target (host dispatch bug) — refusing the wake");
    }
    if (!windowEnabledFor(t.surfaceKey, t.token)) {
      throw new Error(`unified receive: no standing window is enabled for ${t.surfaceKey} — refusing the wake (fail-closed)`);
    }
    const org = deploymentOrg();
    await registerUnifiedWakeTarget(getOperationalStore(), org, t.wakeId, t.origin, new Date().toISOString(), t.token, t.inbound === true, t.addressing);
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
        ...(t.answer.taskId !== undefined ? { taskId: t.answer.taskId } : {}),
        ...(t.answer.optionId !== undefined ? { optionId: t.answer.optionId } : {}),
      };
      const { workspace: answerWorkspace, surface: answerSurface } = auditLabels(t.token);
      try {
        if (answerText === undefined) throw new Error("the delivery is structured content, not text — an answer must be text");
        const session = await from(t.token).respond([{ requestId: t.answer.requestId, text: answerText, ...(t.answer.optionId ? { optionId: t.answer.optionId } : {}) }], {
          auth: input.auth,
          ...(t.context && t.context.length > 0 ? { context: [...t.context] } : {}),
        });
        await forgetBridgedQuestion(getOperationalStore(), org, bare);
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
    return from(t.token).send(input.message, {
      auth: completeWakeAuth(input.auth),
      ...(t.context && t.context.length > 0 ? { context: [...t.context] } : {}),
    });
  },
  events: {
    async "message.completed"(data, channel, ctx) {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
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
      const bridgeRefusal = bridgeBlockingRefusal(refusalsForWakeThisTurn(currentTurnId(bind), currentWakeId(bind)));
      if (shouldBridgeAddressedProse(currentTurnAddressing(bind), replied, bridgeRefusal)) {
        const wakeId = currentWakeId(bind);
        const origin = wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId).catch(() => null) : null;
        if (!origin) {
          ulog(`addressed-mention bridge: UNRESOLVED wake target (wakeId=${currentWakeId(bind) ?? "none"}) — dropping owed prose (audited)`);
          await appendAudit({
            org,
            platform: "unified",
            workspace,
            surface,
            action: "turn.direct_mention_bridge_unresolved",
            detail: { wakeId: currentWakeId(bind) ?? null, chars: action.text.length, ...(sessionId ? { sessionId } : {}) },
          }).catch(() => undefined);
          return;
        }
        try {
          const replier = replierLabelFor(windowGrainOf(bind), windowTaskLabelOf(bind));
          const principalId = authPrincipalId(bind);
          const creatorId = attestedFireCreatorId(bind);
          const turnId = currentTurnId(bind);
          const owingTask = wakeId ? pendingDelegationOwing(turnId, wakeId, addressedWakeThisTurn(turnId)) : undefined;
          const id = await postUnifiedReply(
            origin,
            withRunRefusalBlock(action.text, consumeRoutineRunPermissionRefusals()),
            {},
            {
              org,
              platform: "unified",
              workspace,
              surface,
              ...(principalId ? { principalId } : {}),
              ...(creatorId ? { creatorId } : {}),
              ...(sessionId ? { sessionId } : {}),
              ...(wakeId ? { wakeId } : {}),
              ...(turnId ? { turnId } : {}),
              route: "bridge",
            },
            replier,
          );
          ulog(`addressed-mention bridge: delivered terminal prose (${action.text.length} chars) to ${origin.platform} — id ${id}`);
          if (wakeId) {
            if (owingTask === undefined) {
              await getOperationalStore()
                .markUnifiedWakeAnswered(org, wakeId, new Date().toISOString(), turnId)
                .catch(() => undefined);
            } else {
              ulog(`addressed-mention bridge: wake ${wakeId} left ANSWERABLE — a background task this turn dispatched still owes it (OPE-701)`);
              await appendAudit({
                org,
                platform: "unified",
                workspace,
                surface,
                action: BRIDGE_WAKE_HELD_AUDIT_ACTION,
                detail: { wakeId, chars: action.text.length, ...(sessionId ? { sessionId } : {}) },
              }).catch(() => undefined);
            }
          }
          return;
        } catch (err) {
          const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
          ulog(`addressed-mention bridge: POST FAILED to ${origin.platform} — dropping owed prose (audited): ${errMsg}`);
          await appendAudit({
            org,
            platform: "unified",
            workspace,
            surface,
            action: "turn.direct_mention_bridge_post_failed",
            detail: { platform: origin.platform, chars: action.text.length, error: errMsg, wakeId: currentWakeId(bind) ?? null, ...(sessionId ? { sessionId } : {}) },
          }).catch(() => undefined);
          return;
        }
      }
      const { addressing: addressingKind, reason: dropReason } = ambientProseDropDetail(
        currentTurnAddressing(bind),
        currentTurnAddressed(bind),
        replied,
        bridgeRefusal,
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

      if (!replied && bridgeRefusal === undefined && channel.continuation?.token !== undefined) {
        const wakeId = currentWakeId(bind);
        const rawToken = channel.continuation.token;
        const domain = unifiedDomainFromToken(rawToken);
        const baseAttrs: Record<string, unknown> = { ...(bind.session?.auth?.current?.attributes ?? {}) };
        delete baseAttrs[OE_ADDRESSING_ATTR];
        const reinject: RedriveReinject = buildRedriveReinject(domain, rawToken, baseAttrs);
        const outcome = await maybeRedrive(
          { org, workspace, surface, ...(sessionId ? { sessionId } : {}), wakeId, chars: action.text.length, replied },
          { store: getOperationalStore(), reinject },
        );
        if (outcome.status === "redriven") {
          ulog(`auto-redrive: re-injected a corrective wake for wake ${outcome.originalWakeId} (dropped ${action.text.length} chars) — one more turn to reply`);
        } else if (outcome.status !== "skip-replied") {
          ulog(`auto-redrive: NOT fired (${outcome.status}) for wake ${outcome.originalWakeId ?? "none"} — drop is final`);
        }
      }
    },
    async "input.requested"(data, channel, ctx) {
      try {
        const question = detectBridgeableInputRequest((data as { requests?: unknown } | undefined)?.requests);
        if (!question) return;
        const org = deploymentOrg();
        const { workspace, surface } = auditLabels(channel.continuation?.token);
        const bind = { session: ctx?.session } as unknown as BindableContext;
        const wakeId = currentWakeId(bind);
        const sessionId = typeof ctx?.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
        const outcome = await bridgeQuestionToSurface(
          { org, platform: "unified", workspace, surface, ...(sessionId ? { sessionId } : {}), ...(wakeId ? { wakeId } : {}) },
          question,
          {
            resolveOrigin: async () => (wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId).catch(() => null) : null),
            post: async (origin, text) => postUnifiedReply(origin, text),
          },
        );
        if (outcome.status === "bridged") {
          const bare = bareTokenFromEveContext(channel.continuation?.token);
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
    readonly internalDispatch?: true;
  },
): Promise<void> {
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
  if (input.internalDispatch !== true && (await windowSpendGate(input)) === "declined") {
    ulog(`DECLINED single-window wake ${input.window.wakeId} from ${input.surfaceKey} — over its spend cap (refusal posted, no model turn)`);
    return;
  }
  rememberUnifiedReceive(receive);
  const sources = windowSourcesForDivert(input.token, input.window.origin.platform);
  const bareToken = input.token.startsWith("unified:") ? input.token.slice("unified:".length) : input.token;
  const replyAnchor = input.window.origin.platform === "slack" ? input.window.origin.replyAnchorTs : undefined;
  const auth = stampUnifiedWindowAuth(input.auth, input.window.origin.platform, input.window.wakeId, input.window.addressing, sources, bareToken, replyAnchor, mintWakeId());
  const answer = await resolveInboundAnswer(input, bareToken);
  const target: UnifiedReceiveTarget = {
    token: input.token,
    wakeId: input.window.wakeId,
    origin: input.window.origin,
    ...(answer ? { answer } : {}),
    surfaceKey: input.surfaceKey,
    inbound: input.internalDispatch !== true,
    ...(input.window.addressing ? { addressing: input.window.addressing } : {}),
    ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
  };
  const message = input.message;
  const deliveredAuth = auth;
  try {
    await receive(channel, target).send(message, { auth: completeWakeAuth(deliveredAuth) });
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
    const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await audit({ routed: "standing", reason: "owner-divert-failed", ownerId: route.token, grain: route.grain, error: errMsg });
    return divertToUnifiedWindow(receive, input);
  }
  await audit({ routed: "owner", ownerId: route.token, grain: route.grain });
}

export function buildRedriveReinject(domain: string | undefined, rawToken: string, baseAttrs: Record<string, unknown>): RedriveReinject {
  if (!crossProcessDispatchAvailable()) return null;
  return async (origin, message, originalWakeId) => {
    const surfaceKey = pickRedriveSurfaceKey(domain, origin.platform);
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
}): Promise<void> {
  if (!crossProcessDispatchAvailable()) {
    throw new Error(
      "dispatchTaskWindow: no live cross-surface dispatch is available on this instance — this process has handled no surface webhook (no captured cross-channel dispatch) and the self-dispatch route is not configured (arm OE_CREDENTIAL_ENCRYPTION_KEY; plus OE_PUBLIC_BASE_URL when the deployment's own URL isn't discoverable). Retry from a message-driven turn.",
    );
  }
  const surfaceKey = pickRedriveSurfaceKey(input.domain, input.origin.platform);
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
  readonly authAttributes?: Record<string, unknown>;
}): Promise<boolean> {
  if (!crossProcessDispatchAvailable()) return false;
  const surfaceKey = pickRedriveSurfaceKey(input.domain, input.origin.platform);
  if (!surfaceKey) return false;
  try {
    await deliverUnifiedDispatch({
      message: input.message,
      token: input.token,
      window: { wakeId: input.wakeId, origin: input.origin },
      surfaceKey,
      auth: { attributes: input.authAttributes ?? {} },
    });
    return true;
  } catch {
    return false;
  }
}
