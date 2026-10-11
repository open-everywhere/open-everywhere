import type { TeamsInvokeActivity } from "eve/channels/teams";
import {
  resolveApprovalClick,
  deliverDecisionFeedback,
  clickerFloorRefusalNotice,
  judgeContradictionNotice,
  getOperationalStore,
  surfaceKeySegment,
  type ApprovalClickResolution,
  type ApprovalOutcome,
  type DecisionFeedbackSurface,
  type DecisionWakeDeps,
  type PendingActionRow,
  type UnifiedWakeOrigin,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  TEAMS_ADAPTIVE_CARD_ACTION_INVOKE,
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  decidedTeamsCard,
  judgeLiftNoticeTeamsCard,
  parseTeamsApprovalData,
  pendingTeamsCard,
  teamsCardAttachment,
  type TeamsAdaptiveCard,
  type TeamsApprovalAction,
} from "./teams-card.js";
import { sendTeamsActivityBackedOff, updateTeamsActivityBackedOff } from "../channels/teams-connector.js";
import { teamsChannelGrainConversationId, teamsConversationRef, type TeamsConversationRef } from "../channels/teams-conversation-ref.js";
import { restoreTeamsConversationId } from "../channels/teams-id-restore.js";
import { isTrustedTeamsServiceUrl } from "../channels/teams-origin-codec.js";
import { resolveTeamsUserType, teamsServiceUrlRosterProbe } from "../channels/teams-roster.js";

function log(msg: string): void {
  console.log(`[open-everywhere:teams-approvals] ${msg}`);
}

export type TeamsSend = (input: { readonly serviceUrl: string; readonly conversationId: string; readonly body: unknown }) => Promise<{ id: string }>;
export type TeamsUpdate = (input: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId: string;
  readonly body: unknown;
}) => Promise<{ id: string }>;

export interface TeamsPostDeps {
  readonly send?: TeamsSend;
  readonly resolveRef?: (channelId: string) => Promise<TeamsConversationRef | undefined>;
}

async function liveResolveRef(channelId: string): Promise<TeamsConversationRef | undefined> {
  return teamsConversationRef(await restoreTeamsConversationId(channelId));
}

async function cardConversation(channelId: string, deps: TeamsPostDeps): Promise<TeamsConversationRef | undefined> {
  const ref = await (deps.resolveRef ?? liveResolveRef)(channelId);
  return ref && isTrustedTeamsServiceUrl(ref.serviceUrl) ? ref : undefined;
}

export async function postTeamsApprovalCard(row: PendingActionRow, summaryLines: readonly string[], deps: TeamsPostDeps = {}): Promise<string | undefined> {
  return postTeamsCardMessage(row, deps, "approval card", () => pendingTeamsCard(row, summaryLines));
}

export async function postTeamsJudgeLiftNotice(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string, deps: TeamsPostDeps = {}): Promise<void> {
  await postTeamsCardMessage(row, deps, "judge-lift notice", () => judgeLiftNoticeTeamsCard(row, summaryLines, outcomeLine));
}

async function postTeamsCardMessage(row: PendingActionRow, deps: TeamsPostDeps, what: string, render: () => TeamsAdaptiveCard): Promise<string | undefined> {
  if (!row.channelId) {
    log(`no channel id on the pending row — nothing to post the ${what} to`);
    return undefined;
  }
  try {
    const ref = await cardConversation(row.channelId, deps);
    if (!ref) {
      log(`no conversation reference for the ${what}'s channel — this deployment has never seen an inbound activity there`);
      return undefined;
    }
    const posted = await (deps.send ?? sendTeamsActivityBackedOff)({
      serviceUrl: ref.serviceUrl,
      conversationId: ref.conversationId,
      body: { type: "message", attachments: [teamsCardAttachment(render())] },
    });
    return posted.id.length > 0 ? posted.id : undefined;
  } catch (err) {
    log(`Teams ${what} post failed: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

export async function postTeamsRowDecisionNotice(row: PendingActionRow, text: string, deps: TeamsPostDeps = {}): Promise<unknown> {
  const ref = await cardConversation(row.channelId, deps);
  if (!ref) throw new Error("no Teams conversation reference for the card's channel");
  return (deps.send ?? sendTeamsActivityBackedOff)({ serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, body: { type: "message", text } });
}

export async function teamsRowWakeTarget(row: PendingActionRow, deps: TeamsPostDeps = {}): Promise<{ surfaceKey: string; origin: UnifiedWakeOrigin } | null> {
  if (!row.postedTo) return null;
  try {
    const ref = await cardConversation(row.channelId, deps);
    if (!ref) return null;
    return { surfaceKey: row.postedTo, origin: { platform: "teams", serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, tenantId: ref.tenantId } };
  } catch {
    return null;
  }
}

export const teamsDecisionFeedback: DecisionFeedbackSurface = {
  postNotice: (row, text) => postTeamsRowDecisionNotice(row, text),
  wakeTarget: (row) => teamsRowWakeTarget(row),
};

export interface TeamsApprovalInvoke {
  readonly action: TeamsApprovalAction;
  readonly clickerId?: string;
  readonly clickerName?: string;
  readonly tenantId?: string;
  readonly teamsChannelId?: string;
  readonly conversationId: string;
  readonly serviceUrl: string;
  readonly replyToId?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function parseTeamsApprovalInvoke(activity: unknown): TeamsApprovalInvoke | null {
  if (!isObject(activity) || activity["type"] !== "invoke") return null;
  const invoke = activity as unknown as TeamsInvokeActivity;
  if (invoke.name !== TEAMS_ADAPTIVE_CARD_ACTION_INVOKE) return null;
  const raw = isObject(invoke.raw) ? invoke.raw : (activity as Record<string, unknown>);
  if (raw["channelId"] !== "msteams") return null;
  const value = isObject(invoke.value) ? invoke.value : undefined;
  const actionObj = value && isObject(value["action"]) ? value["action"] : undefined;
  const action = parseTeamsApprovalData(actionObj?.["data"]);
  if (!action) return null;
  const conversationId = nonEmpty(invoke.conversation?.id);
  const serviceUrl = nonEmpty(invoke.serviceUrl);
  if (!conversationId || !serviceUrl) return null;
  const clickerId = nonEmpty(invoke.from?.id);
  const clickerName = nonEmpty(invoke.from?.name);
  const tenantId = nonEmpty(invoke.tenantId) ?? nonEmpty(invoke.conversation?.tenantId);
  const teamsChannelId = nonEmpty(invoke.teamsChannelId);
  const replyToId = nonEmpty(invoke.replyToId);
  return {
    action,
    conversationId,
    serviceUrl,
    ...(clickerId ? { clickerId } : {}),
    ...(clickerName ? { clickerName } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(teamsChannelId ? { teamsChannelId } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
}

export function teamsClickSurfaceKey(invoke: TeamsApprovalInvoke, row: Pick<PendingActionRow, "channelId"> | null): string | undefined {
  const room = invoke.teamsChannelId ?? teamsChannelGrainConversationId(invoke.conversationId);
  if (!invoke.tenantId || !room) return undefined;
  const spelling = surfaceKeySegment(room);
  const channel = row && row.channelId !== room && row.channelId === spelling ? spelling : room;
  return `teams/${invoke.tenantId}/${channel}`;
}

export interface TeamsInvokeResponseBody {
  readonly statusCode: 200;
  readonly type: string;
  readonly value: unknown;
}

const TEAMS_MESSAGE_RESPONSE_TYPE = "application/vnd.microsoft.activity.message";

function messageResponse(text: string): TeamsInvokeResponseBody {
  return { statusCode: 200, type: TEAMS_MESSAGE_RESPONSE_TYPE, value: text };
}

function cardResponse(card: TeamsAdaptiveCard): TeamsInvokeResponseBody {
  return { statusCode: 200, type: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, value: card };
}

export function teamsResponseFor(res: ApprovalClickResolution, deciderLabel?: string): TeamsInvokeResponseBody {
  switch (res.outcome) {
    case "unknown":
      return messageResponse("This approval request is no longer known (it may have already been decided or has aged out).");
    case "not-pending":
    case "expired-race":
    case "lost-race":
      return messageResponse("Nothing changed — this request was already decided.");
    case "unregistered-kind":
      return messageResponse("Nothing changed — this deployment cannot decide this kind of request.");
    case "expired":
      return cardResponse(decidedTeamsCard(res.row, res.summaryLines, "expired"));
    case "denied":
      return messageResponse("Only a domain/org admin can decide this request. It is still pending.");
    case "clicker-denied":
      return messageResponse(clickerFloorRefusalNotice(res.reason));
    case "halted":
      return messageResponse(res.notice);
    case "contradicted":
      return messageResponse(judgeContradictionNotice(res.contradiction));
    case "decided":
      return cardResponse(decidedTeamsCard(res.row, res.summaryLines, res.outcomeLine, deciderLabel));
  }
}

export interface TeamsApprovalDeps {
  readonly resolve?: typeof resolveApprovalClick;
  readonly userType?: (invoke: TeamsApprovalInvoke) => Promise<"guest" | "member" | undefined>;
  readonly readRow?: (org: string, id: string) => Promise<PendingActionRow | null>;
  readonly send?: TeamsSend;
  readonly update?: TeamsUpdate;
  readonly decisionWake?: DecisionWakeDeps;
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

async function liveUserType(invoke: TeamsApprovalInvoke): Promise<"guest" | "member" | undefined> {
  if (!invoke.clickerId) return undefined;
  return resolveTeamsUserType(teamsServiceUrlRosterProbe(invoke.serviceUrl), invoke.conversationId, invoke.clickerId);
}

export async function handleTeamsApprovalInvoke(invoke: TeamsApprovalInvoke, deps: TeamsApprovalDeps = {}): Promise<TeamsInvokeResponseBody> {
  const { action } = invoke;
  try {
    if (!invoke.clickerId) {
      console.error(`[open-everywhere:teams-approvals] approval tap on ${action.id} carries no user id — ignoring the tap`);
      return messageResponse("Couldn't read who clicked — this decision was not applied.");
    }
    const clickerId = invoke.clickerId;
    if (!invoke.tenantId) {
      console.error(`[open-everywhere:teams-approvals] approval tap on ${action.id} carries no tenant — refusing the tap`);
      return messageResponse("Couldn't read where this was clicked — this decision was not applied.");
    }
    const userType = await (deps.userType ?? liveUserType)(invoke).catch(() => undefined);
    const known = await (deps.readRow ?? ((org: string, id: string) => getOperationalStore().getPendingAction(org, id)))(action.org, action.id).catch(() => null);
    const surfaceKey = teamsClickSurfaceKey(invoke, known);
    if (!surfaceKey) return messageResponse("Couldn't read where this was clicked — this decision was not applied.");

    const res = await (deps.resolve ?? resolveApprovalClick)({
      org: action.org,
      id: action.id,
      decision: action.decision,
      clickerId,
      clickerPlatform: "teams",
      clickerTenant: invoke.tenantId,
      clickContext: { surfaceKey },
      ...(userType === undefined ? {} : { clickerIsGuest: userType === "guest" }),
      ...(deps.waitUntil ? { waitUntil: deps.waitUntil } : {}),
    });

    const pending = decisionFeedback(invoke, res, deps);
    if (pending !== undefined) {
      if (deps.waitUntil === undefined) {
        await pending;
      } else {
        deps.waitUntil(
          pending.catch((err: unknown) => {
            log(`deferred decision feedback failed for ${action.id}: ${(err as Error)?.message ?? String(err)}`);
          }),
        );
      }
    }
    return teamsResponseFor(res, invoke.clickerName);
  } catch (err) {
    console.error(`[open-everywhere:teams-approvals] tap handling failed softly for ${action.id}: ${String(err)}`);
    return messageResponse("Something went wrong handling this click — the decision was not applied.");
  }
}

function decisionFeedback(invoke: TeamsApprovalInvoke, res: ApprovalClickResolution, deps: TeamsApprovalDeps): Promise<void> | undefined {
  if (res.outcome !== "decided" && res.outcome !== "expired") return undefined;
  const row = res.row;
  const outcomeLine = res.outcome === "expired" ? "expired" : res.outcomeLine;
  const send = deps.send ?? sendTeamsActivityBackedOff;
  const trusted = isTrustedTeamsServiceUrl(invoke.serviceUrl);
  const postNotice = async (text: string): Promise<unknown> => {
    if (!trusted) throw new Error("the tap's serviceUrl is not a Bot Framework host");
    return send({ serviceUrl: invoke.serviceUrl, conversationId: invoke.conversationId, body: { type: "message", text } });
  };
  const target: { surfaceKey: string; origin: UnifiedWakeOrigin } | null =
    row.postedTo && trusted
      ? {
          surfaceKey: row.postedTo,
          origin: { platform: "teams", serviceUrl: invoke.serviceUrl, conversationId: invoke.conversationId, ...(invoke.tenantId ? { tenantId: invoke.tenantId } : {}) },
        }
      : null;
  const updateCard = async (): Promise<void> => {
    const activityId = row.messageTs ?? invoke.replyToId;
    if (!trusted || !activityId) return;
    const card = decidedTeamsCard(row, res.summaryLines, outcomeLine, res.outcome === "decided" ? invoke.clickerName : undefined);
    await (deps.update ?? updateTeamsActivityBackedOff)({
      serviceUrl: invoke.serviceUrl,
      conversationId: invoke.conversationId,
      activityId,
      body: { type: "message", id: activityId, attachments: [teamsCardAttachment(card)] },
    }).catch((err: unknown) => log(`decided-card update failed for ${row.id}: ${(err as Error)?.message ?? String(err)}`));
  };
  const feedback = deliverDecisionFeedback(
    {
      row,
      summaryLines: res.summaryLines,
      outcome: res.outcome === "expired" ? "expired" : (row.status as ApprovalOutcome),
      outcomeLine,
      executed: res.outcome === "expired" ? "none" : res.executed,
      ...(res.outcome === "decided" ? { clickerId: invoke.clickerId } : {}),
      target,
      postNotice,
    },
    deps.decisionWake,
  );
  return Promise.all([updateCard(), feedback]).then(() => undefined);
}
