import { defineChannel, GET, POST } from "eve/channels";
import type { Session, RouteHandlerArgs } from "eve/channels";
import { SELF_DISPATCH_PATH, handleSelfDispatch, postSelfDispatch, selfDispatchConfigured, type UnifiedDispatchPayload } from "./self-dispatch.js";
import { appendAudit, auditSilencesEnabled } from "../audit/audit.js";
import { deploymentOrg, currentWakeId, currentTurnId, currentTurnAddressing, bindFrom, windowGrainOf, windowTaskLabelOf, type BindableContext } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { windowedSupervisorEnabled } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { registerUnifiedWakeTarget, resolveUnifiedWakeTarget, isUnifiedWakeOrigin, mintWakeId, stampUnifiedWindowAuth, shouldBridgeAddressedProse, unifiedThreadRef, isThreadScopedWakeOrigin, OE_ADDRESSING_ATTR, OE_GRAIN_ATTR, OE_TASK_LABEL_ATTR, type UnifiedWakeOrigin, type UnifiedWindowWake } from "./unified-window.js";
import { postUnifiedReply, completeUnifiedSessionSilently } from "./unified-reply.js";
import {
  detectBridgeableInputRequest,
  bridgeQuestionToSurface,
  forgetBridgedQuestion,
  readBridgedQuestion,
  rememberBridgedQuestion,
  resolveInboundAnswerRouting,
  QUESTION_ANSWERED_AUDIT_ACTION,
  QUESTION_ANSWER_DROPPED_AUDIT_ACTION,
} from "./question-bridge.js";
import { admitInputResponse } from "../approvals/input-response-floor.js";
import { resolvePartition } from "../memory/partition.js";
import { unifiedDomainFromToken, unifiedDomainSessionKey, isUnifiedSupervisorToken } from "./unified-supervisor.js";
import { parseWindowToken, isTaskWindowId, isThreadSeatWindowId, isThreadSeatWindowToken, dmAnchorSurfaceForToken, dmSurfaceKeyFromAnchorDomain, bareTokenFromEveContext } from "./window-key.js";
import { resolveThreadOwner, clearThreadOwner, routeThreadMessage } from "./thread-ownership.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { INVOKER_POSTURE_ATTR } from "../access/invoker-posture.js";
import { currentInvokerPosture } from "../access/invoker-posture-state.js";
import { sourcesForWindow } from "./window-sources.js";
import { finalMessageActionForTurn, replierLabelFor } from "./turn-delivery.js";
import { consumeRepliedThisTurn } from "./reply-signal.js";
import { redriveEnabled, maybeRedrive, type RedriveReinject } from "./unified-redrive.js";
import { unresumableAuditDetail } from "./session-resume.js";
import { collectTaskResultDelta, markRecoveredDelivered } from "../access/task-result-delta.js";
import { resultTaintedAttrs } from "../access/taint-signal.js";
import { admitInboundSurface, providerSelection } from "../access/provider-selection.js";
import { ingressSpendGate } from "../spend/ingress-gate.js";

function ulog(msg: string): void {
  console.log(`[open-everywhere:unified] ${msg}`);
}

type UnifiedSendAuth = Parameters<ReturnType<RouteHandlerArgs["to"]>["send"]>[1]["auth"];

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
    const d = getConfig().loadDomains().find((dm) => dm.name === domain && dm.channels && dm.channels.length > 0);
    if (!d?.channels || d.channels.length === 0) return null;
    return d.channels.find((c) => c.startsWith(`${platform}/`)) ?? d.channels[0];
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
  };
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

function auditLabels(rawToken: string | undefined): { workspace: string; surface: string | undefined } {
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
      const domains = key.windowId === key.domain ? getConfig().loadDomains() : [];
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
    const routing = await resolveInboundAnswerRouting(
      { internalDispatch: input.internalDispatch === true, ...(containerKey ? { containerKey } : {}) },
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
      } else if (routing.reason === "foreign-room") {
        ulog(`the outstanding question on ${bareToken} is showing in another room — this message is an ordinary wake, the question stays open`);
      }
      return undefined;
    }
    return { requestId: routing.requestId, floor: routing.floor, ...(routing.taskId !== undefined ? { taskId: routing.taskId } : {}) };
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
        (typeof t.answer.requestId !== "string" || t.answer.requestId.length === 0 || typeof t.answer.floor !== "string"))
    ) {
      throw new Error("unified receive: malformed target (host dispatch bug) — refusing the wake");
    }
    if (!windowEnabledFor(t.surfaceKey, t.token)) {
      throw new Error(`unified receive: no standing window is enabled for ${t.surfaceKey} — refusing the wake (fail-closed)`);
    }
    const org = deploymentOrg();
    await registerUnifiedWakeTarget(getOperationalStore(), org, t.wakeId, t.origin, new Date().toISOString(), t.token);
    ulog(`wake ${t.wakeId} from ${t.surfaceKey} → ${t.token} (origin ${t.origin.platform})`);
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
      };
      const { workspace: answerWorkspace, surface: answerSurface } = auditLabels(t.token);
      try {
        if (answerText === undefined) throw new Error("the delivery is structured content, not text — an answer must be text");
        const session = await from(t.token).respond([{ requestId: t.answer.requestId, text: answerText }], {
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
      auth: input.auth,
      ...(t.context && t.context.length > 0 ? { context: [...t.context] } : {}),
    });
  },
  events: {
    async "message.completed"(data, channel, ctx) {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const replied = consumeRepliedThisTurn();
      const org = deploymentOrg();
      const { workspace, surface } = auditLabels(channel.continuation?.token);
      if (action.kind === "silent") {
        const bind = { session: ctx.session } as unknown as BindableContext;
        const wakeId = currentWakeId(bind);
        const silentOrigin = wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId).catch(() => null) : null;
        let linearClosed: boolean | undefined;
        if (silentOrigin) {
          try {
            if (await completeUnifiedSessionSilently(silentOrigin)) {
              linearClosed = true;
              ulog(`silent turn: closed the wake's open ${silentOrigin.platform} session without posting (ephemeral stop)`);
            }
          } catch (err) {
            linearClosed = false;
            ulog(`silent turn: FAILED to close the open ${silentOrigin.platform} session (spinner may persist until timeout): ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
          }
        }
        if (auditSilencesEnabled()) {
          await appendAudit({
            org,
            platform: "unified",
            workspace,
            surface,
            action: "unified.no_reply",
            detail: { reason: action.reason, replied, wakeId: wakeId ?? null, ...(linearClosed !== undefined ? { linearClosed } : {}), ...(sessionId ? { sessionId } : {}) },
          }).catch(() => undefined);
        }
        return;
      }
      const bind = { session: ctx.session } as unknown as BindableContext;
      if (shouldBridgeAddressedProse(currentTurnAddressing(bind), replied)) {
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
          const id = await postUnifiedReply(
            origin,
            action.text,
            {},
            {
              org,
              platform: "unified",
              workspace,
              surface,
              ...(sessionId ? { sessionId } : {}),
              ...(wakeId ? { wakeId } : {}),
              route: "bridge",
            },
            replier,
          );
          ulog(`addressed-mention bridge: delivered terminal prose (${action.text.length} chars) to ${origin.platform} — id ${id}`);
          if (wakeId) {
            await getOperationalStore()
              .markUnifiedWakeAnswered(org, wakeId, new Date().toISOString(), currentTurnId(bind))
              .catch(() => undefined);
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
      ulog(`message-tool-only: DROPPED terminal prose (${action.text.length} chars; replied=${replied}) — replies must come from the reply tool`);
      await appendAudit({
        org,
        platform: "unified",
        workspace,
        surface,
        action: "turn.supervisor_prose_dropped",
        detail: { chars: action.text.length, replied, wakeId: currentWakeId(bind) ?? null, ...(sessionId ? { sessionId } : {}) },
      }).catch(() => undefined);

      if (redriveEnabled() && !replied && channel.continuation?.token !== undefined) {
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
        } else if (outcome.status !== "disabled" && outcome.status !== "skip-replied") {
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
    readonly excludeTaskResultId?: string;
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
    ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
  };
  let recovered: { taskIds: readonly string[]; overflow: number } | null = null;
  let recoveredTainted = false;
  let message = input.message;
  if (oneshotAgentEnabled()) {
    try {
      const key = parseWindowToken(bareToken);
      if (key && !isTaskWindowId(key.windowId)) {
        const delta = await collectTaskResultDelta(getOperationalStore(), deploymentOrg(), bareToken, input.excludeTaskResultId);
        if (delta) {
          message = `${message}\n\n${delta.reminder}`;
          recovered = { taskIds: delta.taskIds, overflow: delta.overflow };
          recoveredTainted = delta.tainted;
        }
      }
    } catch {
      recovered = null;
    }
  }
  const deliveredAuth = recoveredTainted
    ? { ...auth, attributes: { ...auth.attributes, ...resultTaintedAttrs(true) } }
    : auth;
  await receive(channel, target).send(message, { auth: deliveredAuth as UnifiedSendAuth });
  if (recovered) {
    const org = deploymentOrg();
    await markRecoveredDelivered(getOperationalStore(), org, recovered.taskIds, new Date().toISOString());
    await appendAudit({
      org,
      platform: "unified",
      workspace: parseWindowToken(bareToken)?.domain ?? "unknown",
      action: "task.result_recovered",
      detail: { taskIds: [...recovered.taskIds], count: recovered.taskIds.length, overflow: recovered.overflow, wakeId: input.window.wakeId },
    }).catch(() => undefined);
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
}): Promise<void> {
  if (!crossProcessDispatchAvailable()) {
    throw new Error(
      "spawn_task: no live cross-surface dispatch is available on this instance — this process has handled no surface webhook (no captured cross-channel dispatch) and the self-dispatch route is not configured (arm OE_CREDENTIAL_ENCRYPTION_KEY; plus OE_PUBLIC_BASE_URL when the deployment's own URL isn't discoverable). Retry from a message-driven turn.",
    );
  }
  const surfaceKey = pickRedriveSurfaceKey(input.domain, input.origin.platform);
  if (!surfaceKey) {
    throw new Error(`spawn_task: couldn't resolve a window-enabled surface for domain "${input.domain}" — the task cannot be dispatched.`);
  }
  const attributes: Record<string, unknown> = { ...(input.parentAuthAttributes ?? {}) };
  attributes[OE_GRAIN_ATTR] = input.grain ?? "task";
  if (input.taskLabel) attributes[OE_TASK_LABEL_ATTR] = input.taskLabel;
  attributes[INVOKER_POSTURE_ATTR] = currentInvokerPosture();
  if (input.tainted) attributes[OE_SPAWN_TAINTED_ATTR] = "true";
  await deliverUnifiedDispatch({
    message: input.message,
    token: input.token,
    window: { wakeId: input.wakeId, origin: input.origin, addressing: "direct-mention" },
    surfaceKey,
    auth: { attributes },
  });
}

export async function dispatchWindowWake(input: {
  readonly token: string;
  readonly origin: UnifiedWakeOrigin;
  readonly wakeId: string;
  readonly message: string;
  readonly domain: string;
  readonly authAttributes: Record<string, unknown>;
  readonly excludeTaskId?: string;
}): Promise<boolean> {
  if (!crossProcessDispatchAvailable()) return false;
  const surfaceKey = pickRedriveSurfaceKey(input.domain, input.origin.platform);
  if (!surfaceKey) return false;
  const attributes = isThreadSeatWindowToken(input.token)
    ? { ...input.authAttributes, [OE_GRAIN_ATTR]: "thread" }
    : input.authAttributes;
  try {
    await deliverUnifiedDispatch({
      message: input.message,
      token: input.token,
      window: { wakeId: input.wakeId, origin: input.origin, addressing: "direct-mention" },
      surfaceKey,
      auth: { attributes },
      ...(input.excludeTaskId ? { excludeTaskResultId: input.excludeTaskId } : {}),
    });
    return true;
  } catch {
    return false;
  }
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
