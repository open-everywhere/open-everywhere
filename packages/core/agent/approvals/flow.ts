import { auditErrorDetail, scrubAuditText } from "../audit/tool-action.js";
import { createHash, randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { recordToolCard } from "../spend/tool-usage.js";
import { getConfig } from "../access/config.js";
import { swallowRoomOp, swallowRoomPost } from "../channels/egress-spoof.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { criteriaDomain } from "../memory/domain.js";
import { seatTokenForwardsWork } from "../access/work-session.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { dmWindowRegistryKey, grainUsesUnifiedWindow, supervisorGrainFor } from "../channels/unified-supervisor.js";
import { dmAnchorDomain, dmAnchorSurfaceForToken, isDmAnchorWindowToken } from "../channels/window-key.js";
import { mintWakeId, unifiedThreadRef, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { dispatchApprovalDecisionWake } from "../channels/unified.js";
import { postSurfaceText, surfaceMessageOps } from "../channels/surface-message-ops.js";
import { renderApprovalDecisionMessage, type ApprovalOutcome } from "./decision-wake.js";
import {
  captureApprovalDecisionAuthority,
  readApprovalDecisionAuthority,
  rememberApprovalDecisionAuthority,
} from "./decision-authority.internal.js";
import { actionKind, whereFromScope } from "./actions.js";
import {
  approvalModeForDomain,
  approversForScopeKey,
  chainAuditDetail,
  preApprovalRulesForScopeKey,
  resolveApproverChain,
  toolForActionKind,
  judgedConnectorOpTool,
  type ApprovalChainRequest,
} from "../access/approver-chain.js";
import { shadowJudgeAuditDetail } from "../access/approval-judge.js";
import { RESUME_TOOL, TOOL_CONSEQUENCE } from "../access/consequence.js";
import { haltAuditDetail, haltClickNotice, haltScopeFor, resolveHalt, type HaltDeps } from "../access/halt.js";
import { parseScopeKey, platformOfScopeKey } from "../access/scope-key.js";
import { rosterHasPrincipal, tryPrincipalKey } from "../identity/principal-key.js";
import { checkClickerFloor, clickRoomMatches, clickerFloorRefusalNotice, type ClickerFloorRefusal } from "./clicker-floor.js";
import { checkCardDisclosure, cardDisclosureRefusalNotice } from "./card-disclosure.js";
import { pendingCardBlocks, decidedCardBlocks, groupedCardBlocks, judgeLiftNoticeBlocks, judgeLiftNoticeText, GROUPED_CARD_MAX_ITEMS, type GroupedCardItem, type RenderedCard } from "./card.js";
import { contradictJudgeAllow, judgeContradictionNotice, type ContradictJudgeAllowOutcome } from "./judge-contradiction.js";
import { applyAllowRule, auditAllowRuleRefused, dmRulesForProposal, planAllowRuleClick, type AllowRulePlan } from "./allow-rule-apply.js";
import { describeDeclaredPermissionKind, grantableFrozenKey, grantReach, sessionGrantKind } from "./session-grant.js";
import {
  consumeCardPostedThisTurn,
  markCardPostedThisTurn,
  noteRoutineRunPermissionRefusal,
  peekCardPostedThisTurn,
} from "./card-signal.js";
import { withArmingApproval } from "./arming-context.js";
import { getSettings } from "../settings/settings.js";
import type { ActionKind, PendingActionRow, PendingStatus } from "./types.js";
import { CLICK_NOTICE, FAILED_OUTCOME_PREFIX, decidedCardLine } from "./card-layout.js";
import type { BindableContext } from "../identity/binding.js";
import "./memory-purge.js";
import "./access-request.js";
import "./skill-create.js";
import "./routine-create.js";
import "./pr-open.js";
import "./skill-delete.js";
import "./routine-cancel.js";
import "./routine-lifecycle.js";
import "./routine-policy.js";
import "./webhook.js";
import "./webhook-declare.js";
import "./mcp-server-propose.js";
import "./meeting-join.js";
import "./email-sender.js";
import "./personal-browser.js";
import "./meeting-recap.js";
import "./agent-create.js";
import "./ticket-actions.js";
import "./ticket-create.js";
import "./chat-post.js";
import "./slack-doc-write.js";
import "./connector-op.js";
import "./a2a-delegate.js";
import "./chat-dm.js";
import "./session-checkpoint.js";
import "./routine-attention.js";
import "./routine-suggest.js";
import { ROUTINE_PERMISSION_KIND, parseRoutinePermissionArgs, routineCardGenerationState } from "./routine-permission.js";
import { ROUTINE_ATTENTION_KIND, type RoutineAttentionArgs } from "../routines/attention.js";
import { getRoutine } from "../routines/store.js";
import { DISPATCH_TICK_MINUTES } from "../routines/schedule.js";
import {
  markRoutinePermissionAsked,
  planRoutinePermissionCard,
  routineCardArmedBy,
  routineCardProbe,
  routinePermissionCardPointer,
  routinePermissionRefusalClause,
  type RoutineCardPointer,
  type RoutinePermissionCardState,
} from "../routines/permission-card.js";
import { routineCardKeepsStateClause, routineCardWaitBudgetMs, routineCardWaitRefusalClause, waitForRoutineCardDecision } from "../routines/permission-card-wait.js";
import {
  registerRoutinePermissionCardOfferer,
  type RoutinePermissionCardOffer,
  type RoutinePermissionCardResult,
} from "./routine-permission-offer.js";
import { ROUTINE_PERMISSION_NO_EXPIRY } from "../routines/declared-permissions.js";
import { readTurnClock } from "../observability/turn-clock.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const OE_APPROVAL_PREFIX = "oe_approval:";

type PostFn = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export type ApprovalDecision = "approve" | "reject" | "approve_session" | "approve_rule" | "contradict";

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["approve", "reject", "approve_session", "approve_rule", "contradict"];

export function parseApprovalAction(actionId: string): { decision: ApprovalDecision; id: string } | null {
  if (!actionId.startsWith(OE_APPROVAL_PREFIX)) return null;
  const rest = actionId.slice(OE_APPROVAL_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const decision = rest.slice(0, sep) as ApprovalDecision;
  const id = rest.slice(sep + 1);
  if (!APPROVAL_DECISIONS.includes(decision) || id.length === 0) return null;
  return { decision, id };
}

function sessionIdFromFrozenArgs(argsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argsJson) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" && parsed.sessionId.length > 0 ? parsed.sessionId : undefined;
  } catch {
    return undefined;
  }
}

function approvalTtlHours(): number {
  return getSettings().approvals.ttlHours;
}

export interface DecisionVenueDetail {
  readonly venuePlatform?: string;
  readonly venueWorkspace?: string;
  readonly venueChannel?: string;
}

function venueRoom(key: string | undefined | null): { readonly platform: string; readonly workspace: string; readonly channel?: string } | undefined {
  if (!key) return undefined;
  const parsed = parseScopeKey(key);
  if (parsed.kind === "surface") return { platform: parsed.platform, workspace: parsed.workspace, channel: parsed.surface };
  if (parsed.kind === "tenant") return { platform: parsed.platform, workspace: parsed.workspace };
  return undefined;
}

function venueDetail(
  where: { readonly postedTo?: string | null; readonly channelId?: string | null; readonly scopeKey: string },
  clickSurfaceKey?: string,
): DecisionVenueDetail {
  const room = venueRoom(where.postedTo) ?? venueRoom(clickSurfaceKey) ?? venueRoom(where.scopeKey);
  const channel = where.channelId ?? room?.channel;
  return {
    ...(room ? { venuePlatform: room.platform, venueWorkspace: room.workspace } : {}),
    ...(channel ? { venueChannel: channel } : {}),
  };
}

export function postedToSurfaceKey(binding: { readonly platform: string; readonly workspace: string }, channelId: string): string {
  return `${binding.platform}/${binding.workspace}/${channelId}`;
}

export interface RequestApprovalInput {
  readonly org: string;
  readonly kind: string;
  readonly args: unknown;
  readonly scopeKey: string;
  readonly domain?: string | null;
  readonly requestedBy: string;
  readonly channelId: string;
  readonly threadTs?: string | null;
  readonly postedTo?: string | null;
  readonly summaryLines?: readonly string[];
  readonly chain?: {
    readonly unattended: boolean;
    readonly tainted?: boolean;
    readonly domain?: string;
  };
  readonly noClockExpiry?: true;
}

export type CardPoster = (row: PendingActionRow, summaryLines: readonly string[]) => Promise<string | undefined>;

const CARD_POSTERS = new Map<string, CardPoster>();

export function registerCardPoster(platform: string, poster: CardPoster): void {
  if (!admitProviderRegistration(platform, "approval-card-poster")) return;
  CARD_POSTERS.set(platform, poster);
}

export function cardPosterFor(platform: string | undefined): CardPoster | undefined {
  return platform === undefined ? undefined : CARD_POSTERS.get(platform);
}

export interface DecisionFeedbackSurface {
  postNotice(row: PendingActionRow, text: string): Promise<unknown>;
  wakeTarget(row: PendingActionRow): Promise<{ surfaceKey: string; origin: UnifiedWakeOrigin } | null>;
}

const DECISION_FEEDBACK_SURFACES = new Map<string, DecisionFeedbackSurface>();

export function registerDecisionFeedbackSurface(platform: string, surface: DecisionFeedbackSurface): void {
  if (!admitProviderRegistration(platform, "decision-feedback-surface")) return;
  DECISION_FEEDBACK_SURFACES.set(platform, surface);
}

export function decisionFeedbackSurfaceFor(platform: string | undefined): DecisionFeedbackSurface | undefined {
  return platform === undefined ? undefined : DECISION_FEEDBACK_SURFACES.get(platform);
}

export type JudgeLiftNoticePoster = (row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string) => Promise<void>;

const JUDGE_LIFT_NOTICE_POSTERS = new Map<string, JudgeLiftNoticePoster>();

export function registerJudgeLiftNoticePoster(platform: string, poster: JudgeLiftNoticePoster): void {
  if (!admitProviderRegistration(platform, "judge-lift-notice-poster")) return;
  JUDGE_LIFT_NOTICE_POSTERS.set(platform, poster);
}

export function judgeLiftNoticePosterFor(platform: string | undefined): JudgeLiftNoticePoster | undefined {
  return platform === undefined ? undefined : JUDGE_LIFT_NOTICE_POSTERS.get(platform);
}

export type JudgeLiftNoticeRender = "poster" | "blocks" | "text" | "none";

export function judgeLiftNoticeRenderFor(platform: string | undefined): JudgeLiftNoticeRender {
  if (platform === undefined) return "none";
  if (JUDGE_LIFT_NOTICE_POSTERS.has(platform)) return "poster";
  if (platform === "slack") return "blocks";
  return surfaceMessageOps(platform) !== undefined ? "text" : "none";
}

export function hasJudgeLiftNoticePath(platform: string): boolean {
  return judgeLiftNoticeRenderFor(platform) !== "none";
}

async function postJudgeLiftNotice(
  platform: string | undefined,
  post: PostFn,
  input: { readonly kind: string; readonly scopeKey: string; readonly channelId: string; readonly threadTs?: string | null; readonly postedTo?: string | null },
  row: PendingActionRow,
  summarize: () => readonly string[],
  outcomeLine: string,
): Promise<void> {
  const render = judgeLiftNoticeRenderFor(platform);
  if (render === "none") return;
  if (input.postedTo && !(await checkCardDisclosure(input.postedTo)).ok) return;
  if (swallowRoomOp(`a judge-lift notice for "${input.kind}" (${input.scopeKey})`)) return;
  try {
    const noticeLines = summarize();
    if (render === "poster") await judgeLiftNoticePosterFor(platform)!(row, noticeLines, outcomeLine);
    else if (render === "blocks") await postRenderedCard(post, input.channelId, input.threadTs, judgeLiftNoticeBlocks(row, noticeLines, outcomeLine));
    else await postSurfaceText(platform!, { channelId: input.channelId, text: judgeLiftNoticeText(row, noticeLines, outcomeLine), threadTs: input.threadTs });
  } catch {
  }
}

export interface AutoApprovedOutcome {
  readonly outcome: string;
  readonly resolvedBy: string;
  readonly grantedBy?: string;
}

interface RoutinePermissionCardOutcome extends RoutinePermissionCardResult {
  readonly armedBy?: string;
  readonly waited?: boolean;
}

export interface RequestApprovalResult {
  readonly id: string;
  readonly expiresAt: string;
  readonly deduped?: boolean;
  readonly autoApproved?: AutoApprovedOutcome;
  readonly priorRejection?: PriorRejection;
}

export interface PriorRejection {
  readonly decidedBy: string;
  readonly decidedAt: string;
}

interface WedgeIdentity {
  readonly org: string;
  readonly kind: string;
  readonly scopeKey: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly argsJson: string;
  readonly requestedBy: string;
  readonly decidedBy: string;
}

function wedgeActionId(identity: WedgeIdentity): string {
  const turn = readTurnClock();
  if (turn === undefined || turn === null || turn.turnId.length === 0 || turn.sessionId.length === 0) return randomUUID();
  const material = JSON.stringify([turn.sessionId, turn.turnId, identity.org, identity.kind, identity.scopeKey, identity.channelId, identity.threadTs, identity.argsJson, identity.requestedBy, identity.decidedBy]);
  return uuidFromDigest(createHash("sha256").update(material).digest("hex"));
}

const HALT_LIFT_ACTION_KIND: string | undefined = (() => {
  const via = TOOL_CONSEQUENCE[RESUME_TOOL]?.via;
  return via !== undefined && via.kind === "action-kind" ? via.action : undefined;
})();

function dedupIdentity(argsJson: string, proseArgs: readonly string[] | undefined): string {
  if (proseArgs === undefined || proseArgs.length === 0) return argsJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return argsJson;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return argsJson;
  return JSON.stringify(Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([k]) => !proseArgs.includes(k))));
}

async function closePendingAction(
  store: ReturnType<typeof getOperationalStore>,
  org: string,
  row: Pick<PendingActionRow, "id" | "kind" | "argsJson">,
  status: "rejected" | "expired",
  decidedBy: string,
  decidedAt: string,
): Promise<boolean> {
  const won = await store.decidePendingAction(org, row.id, status, decidedBy, decidedAt);
  if (won) await applyArgsAfterClose(store, org, row);
  return won;
}

async function applyArgsAfterClose(store: ReturnType<typeof getOperationalStore>, org: string, row: Pick<PendingActionRow, "id" | "kind" | "argsJson">): Promise<void> {
  const close = actionKind(row.kind)?.argsAfterClose;
  if (close === undefined) return;
  try {
    const next = JSON.stringify(close(JSON.parse(row.argsJson) as unknown));
    if (next !== row.argsJson) await store.rewriteDecidedPendingActionArgs(org, row.id, next);
  } catch (err) {
    console.warn(`[open-everywhere:approvals] could not clear the closed row ${row.id}'s args: ${String(err)}`);
  }
}

function uuidFromDigest(hex: string): string {
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function redeliveryActionId(kindDef: Pick<ActionKind, "volatileArgs">, input: RequestApprovalInput): string | undefined {
  const volatileArgs = kindDef.volatileArgs;
  if (volatileArgs === undefined || volatileArgs.length === 0) return undefined;
  const turn = readTurnClock();
  if (turn === undefined || turn === null || turn.turnId.length === 0 || turn.sessionId.length === 0) return undefined;
  const args = input.args;
  const stable =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([k]) => !volatileArgs.includes(k)))
      : args;
  const material = JSON.stringify([turn.sessionId, turn.turnId, input.org, input.kind, input.scopeKey, input.channelId, input.threadTs ?? null, JSON.stringify(stable ?? null), input.requestedBy]);
  return uuidFromDigest(createHash("sha256").update(material).digest("hex"));
}

export function autoApprovedNote(what: string, autoApproved: AutoApprovedOutcome): string {
  if (autoApproved.grantedBy !== undefined) {
    return (
      `done — ${what}: this run was refused, a permission card went to the routine's room, and <@${autoApproved.grantedBy}> approved it while the run was still waiting — ` +
      `so it ran, and every later run of this instruction may do it without asking. ${autoApproved.outcome}. Tell the user.`
    );
  }
  return (
    `done — ${what}: the approver chain auto-approved this (${autoApproved.resolvedBy}), so no card was posted and it has ALREADY run — ` +
    `${autoApproved.outcome}. Tell the user; there is no card for them to see.`
  );
}

export interface RequestApprovalDeps {
  readonly post?: PostFn;
  readonly postCard?: CardPoster;
  readonly authorityContext?: BindableContext;
}

function proposingSessionKey(): string | undefined {
  const turn = readTurnClock();
  return turn !== undefined && turn !== null && turn.sessionId.length > 0 ? turn.sessionId : undefined;
}

function groupItemFor(member: PendingActionRow): GroupedCardItem {
  return { row: member, summaryLines: summaryLinesFor(member) };
}

async function joinOpenGroupedCard(
  store: ReturnType<typeof getOperationalStore>,
  post: PostFn,
  row: PendingActionRow,
  summaryLines: readonly string[],
  nowIso: string,
): Promise<string | undefined> {
  if (!row.groupKey) return undefined;
  const sameJob = (r: PendingActionRow): boolean =>
    r.id !== row.id &&
    r.groupKey === row.groupKey &&
    r.channelId === row.channelId &&
    (r.threadTs ?? null) === (row.threadTs ?? null) &&
    (r.postedTo ?? null) === (row.postedTo ?? null) &&
    typeof r.messageTs === "string" &&
    r.messageTs.length > 0 &&
    r.expiresAt > nowIso;
  const open = (await store.listPendingActions(row.org)).filter(sameJob);
  const target = open[open.length - 1]?.messageTs;
  if (!target) return undefined;
  const before = await store.listPendingActionsForMessage(row.org, row.channelId, target);
  if (before.length >= GROUPED_CARD_MAX_ITEMS || before.some((m) => m.groupKey !== row.groupKey)) return undefined;
  await store.setPendingActionMessage(row.org, row.id, target);
  const render = async (): Promise<{ ok: boolean; count: number }> => {
    const members = await store.listPendingActionsForMessage(row.org, row.channelId, target);
    const items = members.map((m) => (m.id === row.id ? { row: m, summaryLines } : groupItemFor(m)));
    return { ok: await rewriteCard(post, row.channelId, target, groupedCardBlocks(items)), count: members.length };
  };
  const rendered = await render();
  if (rendered.ok) {
    const after = await store.listPendingActionsForMessage(row.org, row.channelId, target).catch(() => undefined);
    if (after !== undefined && after.length !== rendered.count) await render().catch(() => undefined);
    return target;
  }
  await store.setPendingActionMessage(row.org, row.id, "").catch(() => undefined);
  return undefined;
}

async function rewriteCard(post: PostFn, channelId: string, ts: string, card: RenderedCard): Promise<boolean> {
  if (swallowRoomOp("a slack grouped approval-card rewrite")) return true;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("ts", ts);
  body.set("text", card.text);
  body.set("blocks", JSON.stringify(card.blocks));
  if (card.metadata) body.set("metadata", JSON.stringify(card.metadata));
  const res = await post("chat.update", body.toString()).catch(() => undefined);
  return res?.ok === true;
}

async function decidedRenderFor(decided: PendingActionRow, summaryLines: readonly string[], outcomeLine: string, channelId: string, messageTs: string | undefined): Promise<RenderedCard> {
  if (messageTs && decided.groupKey) {
    const members = await getOperationalStore()
      .listPendingActionsForMessage(decided.org, channelId, messageTs)
      .catch(() => [] as readonly PendingActionRow[]);
    if (members.length > 1 && members.some((m) => m.id === decided.id)) {
      return groupedCardBlocks(members.map((m) => (m.id === decided.id ? { row: decided, summaryLines, outcomeLine } : groupItemFor(m))));
    }
  }
  return decidedCardBlocks(decided, summaryLines, outcomeLine);
}

async function redrawGroupedCard(post: PostFn, org: string, channelId: string, messageTs: string | undefined): Promise<void> {
  if (!messageTs) return;
  const members = await getOperationalStore()
    .listPendingActionsForMessage(org, channelId, messageTs)
    .catch(() => [] as readonly PendingActionRow[]);
  if (members.length < 2 || !members.every((m) => typeof m.groupKey === "string" && m.groupKey.length > 0)) return;
  await rewriteCard(post, channelId, messageTs, groupedCardBlocks(members.map(groupItemFor))).catch(() => undefined);
}

async function messageHostsOtherRows(org: string, channelId: string, messageTs: string | undefined, id: string): Promise<boolean> {
  if (!messageTs) return false;
  const members = await getOperationalStore()
    .listPendingActionsForMessage(org, channelId, messageTs)
    .catch(() => [] as readonly PendingActionRow[]);
  return members.some((m) => m.id !== id && typeof m.groupKey === "string" && m.groupKey.length > 0);
}

export async function requestApproval(
  input: RequestApprovalInput,
  deps: RequestApprovalDeps = {},
): Promise<RequestApprovalResult> {
  const kindDef = actionKind(input.kind);
  if (!kindDef) {
    throw new Error(`requestApproval: no registered ActionKind for "${input.kind}"`);
  }

  const connectorChainTool = judgedConnectorOpTool(input.kind, input.args, input.chain);
  const chainTool = toolForActionKind(input.kind) ?? connectorChainTool;
  if (chainTool !== undefined) {
    const chainDomain = input.domain ?? input.chain?.domain ?? null;
    const chainReq: ApprovalChainRequest = {
      tool: chainTool,
      action: input.kind,
      args: input.args,
      scopeKey: input.scopeKey,
      ...(chainDomain != null ? { domain: chainDomain } : {}),
      org: input.org,
      principalId: input.requestedBy,
      unattended: input.chain?.unattended ?? true,
      ...(chainDomain != null ? { mode: approvalModeForDomain(chainDomain) } : {}),
      halted: (await resolveHalt(haltScopeFor({ org: input.org, scopeKey: input.scopeKey, domain: chainDomain, ...(input.requestedBy !== undefined ? { principalId: input.requestedBy } : {}) }))).halted,
      ...(kindDef.beneficiaryClicker === true ? { beneficiaryClicker: true } : {}),
    };
    const proposalIdentity = dedupIdentity(JSON.stringify(input.args ?? null), kindDef.proseArgs);
    const dmRules = await dmRulesForProposal(input.org, input.scopeKey, input.requestedBy, async (sourceActionId) => {
      const source = await getOperationalStore().getPendingAction(input.org, sourceActionId);
      return (
        source !== null &&
        source.status === "approved" &&
        source.kind === input.kind &&
        source.scopeKey === input.scopeKey &&
        dedupIdentity(source.argsJson, kindDef.proseArgs) === proposalIdentity
      );
    });
    const chainRules = [...preApprovalRulesForScopeKey(input.scopeKey, chainDomain ?? undefined), ...dmRules];
    const resolution = await resolveApproverChain(chainReq, {
      approvers: approversForScopeKey(input.scopeKey, chainDomain ?? undefined),
      rules: chainRules,
      judge: true,
    });
    await appendAudit({
      ...whereFromScope(input.org, input.scopeKey),
      principalId: input.requestedBy,
      action: "approval.chain",
      detail: chainAuditDetail(chainReq, resolution),
    }).catch(() => undefined);

    if (resolution.judge !== undefined) {
      await appendAudit({
        ...whereFromScope(input.org, input.scopeKey),
        principalId: input.requestedBy,
        action: "approval.judge.verdict",
        detail: {
          tool: chainTool,
          action: input.kind,
          mode: "enforce",
          verdict: resolution.judge.verdict,
          enforcedVerdict: resolution.verdict,
          resolvedBy: resolution.resolvedBy,
          registryVerdict: resolution.registryVerdict,
          source: resolution.judge.source,
          passes: resolution.judge.passes,
          ...(resolution.judge.pass1 !== undefined ? { pass1: resolution.judge.pass1 } : {}),
          ...(resolution.judge.ruleId !== undefined ? { ruleId: resolution.judge.ruleId } : {}),
          ...(resolution.judge.ruleCitation !== undefined ? { ruleCitation: resolution.judge.ruleCitation } : {}),
          reasoning: resolution.judge.reasoning,
          cacheKey: resolution.judge.cacheKey,
          cacheHit: resolution.judge.cacheHit,
          unattended: chainReq.unattended,
          ...(chainDomain != null ? { domain: chainDomain } : {}),
        },
      }).catch(() => undefined);
    }

    void shadowJudgeAuditDetail(chainReq, resolution, undefined, chainRules)
      .then((shadowDetail) =>
        shadowDetail === undefined
          ? undefined
          : appendAudit({
              ...whereFromScope(input.org, input.scopeKey),
              principalId: input.requestedBy,
              action: "approval.judge.shadow",
              detail: shadowDetail,
            }),
      )
      .catch(() => undefined);

    if (resolution.verdict === "deny") {
      const denied = (): void => emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "denied" });
      const reason = resolution.transforms.find((t) => t.to === "deny")?.reason;
      if (resolution.resolvedBy === "judge") {
        denied();
        throw new Error(
          `"${input.kind}" was DENIED by the approval judge — nothing was proposed and no card was posted. ` +
            `The judge's reasoning is recorded in the audit log (approval.judge.verdict); if this looks wrong, a person can propose the action themselves, and the operator can review this verb's defer flip.`,
        );
      }
      const card: RoutinePermissionCardOutcome =
        reason === "ask-unattended"
          ? await offerRoutinePermissionCardForProposal(input, { deps })
          : { clause: "" };
      if (card.armedBy !== undefined) {
        const store = getOperationalStore();
        const decidedAt = new Date().toISOString();
        const wedgeArgsJson = JSON.stringify(input.args ?? null);
        const wedge: PendingActionRow = {
          id: wedgeActionId({
            org: input.org,
            kind: input.kind,
            scopeKey: input.scopeKey,
            channelId: input.channelId,
            threadTs: input.threadTs ?? null,
            argsJson: wedgeArgsJson,
            requestedBy: input.requestedBy,
            decidedBy: card.armedBy,
          }),
          org: input.org,
          kind: input.kind,
          argsJson: wedgeArgsJson,
          scopeKey: input.scopeKey,
          domain: input.domain ?? null,
          requestedBy: input.requestedBy,
          channelId: input.channelId,
          threadTs: input.threadTs ?? null,
          messageTs: null,
          postedTo: input.postedTo ?? null,
          status: "approved",
          createdAt: decidedAt,
          expiresAt: decidedAt,
          decidedBy: card.armedBy,
          decidedAt,
        };
        const minted = await store.addPendingActionIfAbsent(wedge);
        const outcome = await kindDef.execute(input.args, card.armedBy);
        await appendAudit({
          ...whereFromScope(input.org, input.scopeKey),
          principalId: card.armedBy,
          action: "approval.autoapproved",
          detail: {
            id: wedge.id,
            kind: input.kind,
            scopeKey: input.scopeKey,
            resolvedBy: "routine-permission-card",
            transforms: resolution.transforms.map((t) => t.name),
            ...(minted ? {} : { wedgeRowReused: true }),
          },
        }).catch(() => undefined);
        emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "autoapproved" });
        return { id: wedge.id, expiresAt: wedge.expiresAt, autoApproved: { outcome, resolvedBy: "routine-permission-card", grantedBy: card.armedBy } };
      }
      denied();
      throw new Error(
        `"${input.kind}" was DENIED by the approver chain (${resolution.resolvedBy}${reason !== undefined ? `, ${reason}` : ""}) — ` +
          `nothing was proposed and no card was posted. ${
            reason === "ask-unattended"
              ? card.waited === true
                ?
                  "Arm the permission on the routine's creation card, or ask a person to do this."
                : "An unattended run cannot wait on an approval card; arm the permission on the routine's creation card, or ask a person to do this."
              : "This refusal is config-reviewed policy; a config diff to the denying element is the only way to lift it."
          }${card.clause}`,
      );
    }

    if (resolution.verdict === "allow" && resolution.registryVerdict === "ask" && (connectorChainTool === undefined || resolution.resolvedBy === "judge")) {
      const store = getOperationalStore();
      const now = new Date();
      const decidedBy = `chain:${resolution.resolvedBy}`;
      const rowArgsJson = JSON.stringify(input.args ?? null);
      const row: PendingActionRow = {
        id: wedgeActionId({
          org: input.org,
          kind: input.kind,
          scopeKey: input.scopeKey,
          channelId: input.channelId,
          threadTs: input.threadTs ?? null,
          argsJson: rowArgsJson,
          requestedBy: input.requestedBy,
          decidedBy,
        }),
        org: input.org,
        kind: input.kind,
        argsJson: rowArgsJson,
        scopeKey: input.scopeKey,
        domain: input.domain ?? null,
        requestedBy: input.requestedBy,
        channelId: input.channelId,
        threadTs: input.threadTs ?? null,
        messageTs: null,
        postedTo: input.postedTo ?? null,
        status: "approved",
        createdAt: now.toISOString(),
        expiresAt: now.toISOString(),
        decidedBy,
        decidedAt: now.toISOString(),
      };
      const minted = await store.addPendingActionIfAbsent(row);
      const outcome = await kindDef.execute(input.args, decidedBy);
      const noticePlatform = resolution.resolvedBy === "judge" ? platformOfScopeKey(input.postedTo) : undefined;
      if (noticePlatform !== undefined) {
        await postJudgeLiftNotice(noticePlatform, deps.post ?? bridgeSlackForm, input, row, () => (input.summaryLines ? [...input.summaryLines] : kindDef.summarize(input.args)), outcome);
      }
      await appendAudit({
        ...whereFromScope(input.org, input.scopeKey),
        principalId: input.requestedBy,
        action: "approval.autoapproved",
        detail: {
          id: row.id,
          kind: input.kind,
          scopeKey: input.scopeKey,
          resolvedBy: resolution.resolvedBy,
          transforms: resolution.transforms.map((t) => t.name),
          ...(minted ? {} : { wedgeRowReused: true }),
        },
      }).catch(() => undefined);
      emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "autoapproved" });
      return { id: row.id, expiresAt: row.expiresAt, autoApproved: { outcome, resolvedBy: resolution.resolvedBy } };
    }
  }

  if (input.postedTo) {
    const disclosure = await checkCardDisclosure(input.postedTo);
    if (!disclosure.ok) {
      await appendAudit({
        ...whereFromScope(input.org, input.scopeKey),
        principalId: input.requestedBy,
        action: "approval.denied",
        detail: {
          kind: input.kind,
          scopeKey: input.scopeKey,
          postedTo: input.postedTo,
          ...venueDetail({ postedTo: input.postedTo, channelId: input.channelId, scopeKey: input.scopeKey }),
          reason: disclosure.reason,
          at: "propose",
        },
      }).catch(() => undefined);
      emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "withheld" });
      throw new Error(cardDisclosureRefusalNotice(disclosure.room));
    }
  }

  const post = deps.post ?? bridgeSlackForm;
  const store = getOperationalStore();

  const now = new Date();
  const expiresAt = input.noClockExpiry ? ROUTINE_PERMISSION_NO_EXPIRY : new Date(now.getTime() + approvalTtlHours() * 3_600_000).toISOString();
  const argsJson = JSON.stringify(input.args ?? null);

  const nowIso = now.toISOString();
  const identity = dedupIdentity(argsJson, kindDef.proseArgs);
  const dup = (await store.listPendingActions(input.org)).find(
    (r) =>
      r.kind === input.kind &&
      r.scopeKey === input.scopeKey &&
      r.channelId === input.channelId &&
      dedupIdentity(r.argsJson, kindDef.proseArgs) === identity &&
      r.expiresAt > nowIso,
  );
  if (dup) {
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "deduped" });
    return { id: dup.id, expiresAt: dup.expiresAt, deduped: true };
  }

  const rejectedSince = new Date(now.getTime() - approvalTtlHours() * 3_600_000).toISOString();
  const closedIdentity = kindDef.argsAfterClose === undefined ? identity : dedupIdentity(JSON.stringify(kindDef.argsAfterClose(input.args ?? null)), kindDef.proseArgs);
  const priorRejection = await findPriorRejection(store, input, kindDef, [identity, closedIdentity], rejectedSince);

  const decisionAuthority = deps.authorityContext === undefined ? undefined : await captureApprovalDecisionAuthority(deps.authorityContext);

  let id: string = randomUUID();
  const redeliveryId = redeliveryActionId(kindDef, input);
  if (redeliveryId !== undefined) {
    const prior = await store.getPendingAction(input.org, redeliveryId);
    if (prior === null) {
      id = redeliveryId;
    } else if (prior.status === "pending" && prior.expiresAt > nowIso) {
      emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "deduped" });
      return { id: prior.id, expiresAt: prior.expiresAt, deduped: true };
    }
  }

  const groupKey = proposingSessionKey();
  let row: PendingActionRow = {
    ...(groupKey !== undefined ? { groupKey } : {}),
    id,
    org: input.org,
    kind: input.kind,
    argsJson,
    scopeKey: input.scopeKey,
    domain: input.domain ?? null,
    requestedBy: input.requestedBy,
    channelId: input.channelId,
    threadTs: input.threadTs ?? null,
    messageTs: null,
    postedTo: input.postedTo ?? null,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt,
    decidedBy: null,
    decidedAt: null,
  };

  if (row.id === redeliveryId) {
    if (!(await store.addPendingActionIfAbsent(row))) {
      const winner = await store.getPendingAction(input.org, row.id);
      if (winner !== null && winner.status === "pending" && winner.expiresAt > nowIso) {
        emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "deduped" });
        return { id: winner.id, expiresAt: winner.expiresAt, deduped: true };
      }
      const fresh: PendingActionRow = { ...row, id: randomUUID() };
      await store.addPendingAction(fresh);
      row = fresh;
    }
  } else {
    await store.addPendingAction(row);
  }

  if (decisionAuthority !== undefined) {
    try {
      await rememberApprovalDecisionAuthority(row.org, row.id, row.expiresAt, decisionAuthority);
    } catch (err) {
      await closePendingAction(store, row.org, row, "expired", "system", new Date().toISOString()).catch(() => false);
      await appendAudit({
        ...whereFromScope(row.org, row.scopeKey),
        principalId: row.requestedBy,
        action: "approval.expired",
        detail: { id: row.id, kind: row.kind, cause: "decision_authority_store_failed" },
      }).catch(() => undefined);
      throw new Error(`requestApproval: could not freeze the proposing seat authority; marked expired and did not post a card: ${String(err)}`);
    }
  }

  const summaryLines = input.summaryLines ? [...input.summaryLines] : kindDef.summarize(input.args);

  let messageTs = swallowRoomPost(`an approval-card post for "${input.kind}" (${input.scopeKey})`, "card");
  let postFailure: string | undefined;
  if (messageTs === undefined) {
    if (deps.postCard) {
      messageTs = await deps.postCard(row, summaryLines);
      if (!messageTs) postFailure = "the surface's own card post did not land and reported no reason";
    } else {
      messageTs = await joinOpenGroupedCard(store, post, row, summaryLines, nowIso).catch(() => undefined);
      if (messageTs === undefined) {
        const posted = await postRenderedCard(post, input.channelId, input.threadTs, pendingCardBlocks(row, summaryLines));
        messageTs = posted.ts;
        postFailure = posted.error;
      }
    }
  }

  if (!messageTs) {
    await closePendingAction(store, input.org, row, "expired", "system", new Date().toISOString()).catch(() => false);
    await appendAudit({
      ...whereFromScope(input.org, input.scopeKey),
      principalId: input.requestedBy,
      action: "approval.expired",
      detail: { id: row.id, kind: input.kind, cause: "card_post_failed", ...(postFailure ? { reason: postFailure } : {}) },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "failed" });
    const reason = postFailure ?? "the surface refused the post";
    throw Object.assign(
      new Error(`requestApproval: failed to post the approval card for "${input.kind}" (${input.scopeKey}) — ${reason}; marked expired, nothing is awaiting a click.`),
      { [CARD_POST_REASON_KEY]: reason },
    );
  }

  await store.setPendingActionMessage(input.org, row.id, messageTs);
  markCardPostedThisTurn();
  await appendAudit({
    ...whereFromScope(input.org, input.scopeKey),
    principalId: input.requestedBy,
    action: "approval.requested",
    detail: { id: row.id, kind: input.kind, scopeKey: input.scopeKey, ...(row.domain ? { domain: row.domain } : {}) },
  });
  await recordToolCard({ org: input.org, kind: input.kind, args: input.args, surfaceKey: input.postedTo ?? input.scopeKey, principalId: input.requestedBy });
  emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "ok" });

  return { id: row.id, expiresAt, ...(priorRejection !== undefined ? { priorRejection } : {}) };
}

async function findPriorRejection(
  store: ReturnType<typeof getOperationalStore>,
  input: RequestApprovalInput,
  kindDef: Pick<ActionKind, "proseArgs">,
  identities: readonly string[],
  sinceIso: string,
): Promise<PriorRejection | undefined> {
  const rows = await Promise.resolve()
    .then(() => store.listRejectedActionsSince(input.org, sinceIso))
    .catch(() => [] as readonly PendingActionRow[]);
  const match = rows.find(
    (r) =>
      r.kind === input.kind &&
      r.scopeKey === input.scopeKey &&
      r.channelId === input.channelId &&
      r.decidedBy !== null &&
      r.decidedAt !== null &&
      r.decidedAt >= sinceIso &&
      identities.includes(dedupIdentity(r.argsJson, kindDef.proseArgs)),
  );
  return match === undefined ? undefined : { decidedBy: match.decidedBy as string, decidedAt: match.decidedAt as string };
}

async function offerRoutinePermissionCardForProposal(
  input: RequestApprovalInput,
  ctx: { readonly deps: RequestApprovalDeps },
): Promise<RoutinePermissionCardOutcome> {
  const grantKey = sessionIdFromFrozenArgs(JSON.stringify(input.args ?? null));
  if (grantKey === undefined) return { clause: "" };
  return await offerRoutinePermissionCard(
    {
      org: input.org,
      declaration: input.kind,
      grantKind: input.kind,
      grantKey,
      scopeKey: input.scopeKey,
      domain: input.domain ?? null,
      requestedBy: input.requestedBy,
      waitBudgetMs: routineCardWaitBudgetMs(),
    },
    ctx.deps,
  );
}

async function offerRoutinePermissionCard(
  offer: RoutinePermissionCardOffer,
  deps: RequestApprovalDeps,
): Promise<RoutinePermissionCardOutcome> {
  try {
    const budgetMs = offer.waitBudgetMs;
    const grantKey = offer.grantKey;
    const plan = await planRoutinePermissionCard({
      org: offer.org,
      declaration: offer.declaration,
      grantKey,
      scopeKey: offer.scopeKey,
      domain: offer.domain ?? null,
      requestedBy: offer.requestedBy,
      nowIso: new Date().toISOString(),
    });
    if (!plan.card || plan.askedMemoKind === undefined) {
      const at = plan.cardId ? await routinePermissionCardPointer(offer.org, plan.cardId) : {};
      const clause = routinePermissionRefusalClause(plan.state, false, at.permalink);
      if (budgetMs <= 0 || plan.cardId === undefined || plan.grantKind === undefined) {
        noteRunRefusal(plan.state, plan.grantKind, at, plan.cardId !== undefined);
        return { clause };
      }
      const settled = await settleRoutineCardWait(offer.org, { cardId: plan.cardId, grantKey, grantKind: plan.grantKind }, clause, budgetMs);
      return noteUnlessArmed(settled, plan.state, plan.grantKind, at, true);
    }
    if (!hasApprovalCardPath(plan.platform ?? "")) return { clause: "" };
    const hadCardSignal = peekCardPostedThisTurn();
    const poster = cardPosterFor(plan.platform ?? "");
    let cardId: string | undefined;
    try {
      const posted = await requestApproval(plan.card, {
        ...(deps.post ? { post: deps.post } : {}),
        ...(poster ? { postCard: poster } : {}),
      });
      cardId = posted.id;
    } finally {
      if (!hadCardSignal) consumeCardPostedThisTurn();
    }
    await markRoutinePermissionAsked(
      offer.org,
      grantKey,
      plan.askedMemoKind,
      offer.requestedBy,
      new Date().toISOString(),
    );
    const at = cardId ? await routinePermissionCardPointer(offer.org, cardId) : {};
    const clause = routinePermissionRefusalClause(plan.state, true, at.permalink);
    if (budgetMs <= 0 || plan.grantKind === undefined) {
      noteRunRefusal(plan.state, plan.grantKind, at, cardId !== undefined);
      return { clause };
    }
    const settled = await settleRoutineCardWait(offer.org, { cardId, grantKey, grantKind: plan.grantKind }, clause, budgetMs);
    return noteUnlessArmed(settled, plan.state, plan.grantKind, at, cardId !== undefined);
  } catch {
    return { clause: "" };
  }
}

registerRoutinePermissionCardOfferer(async (offer) => ({ clause: (await offerRoutinePermissionCard(offer, {})).clause }));

function noteUnlessArmed(
  settled: RoutinePermissionCardOutcome,
  state: RoutinePermissionCardState,
  grantKind: string | undefined,
  at: RoutineCardPointer,
  cardPosted: boolean,
): RoutinePermissionCardOutcome {
  if (settled.armedBy === undefined) noteRunRefusal(state, grantKind, at, cardPosted);
  return settled;
}

function noteRunRefusal(state: RoutinePermissionCardState, grantKind: string | undefined, at: RoutineCardPointer, cardPosted: boolean): void {
  if (grantKind === undefined) return;
  noteRoutineRunPermissionRefusal({
    permission: describeDeclaredPermissionKind(grantKind),
    card: at.permalink ?? null,
    cardPosted,
    cardCapped: false,
    cardKnown: state !== "unreadable",
  });
}

async function settleRoutineCardWait(
  org: string,
  ctx: { readonly cardId: string; readonly grantKey: string; readonly grantKind: string },
  cardClause: string,
  budgetMs: number,
): Promise<RoutinePermissionCardOutcome> {
  const outcome = await waitForRoutineCardDecision(budgetMs, {
    probe: () => routineCardProbe(org, ctx.cardId, ctx.grantKey, ctx.grantKind),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    nowMs: () => Date.now(),
  });
  emitTelemetry("oe.feature.used", { "oe.feature": "routine_permission_card_wait", "oe.outcome": outcome });
  if (outcome === "approved") {
    const armedBy = await routineCardArmedBy(org, ctx.grantKey, ctx.grantKind);
    if (armedBy !== undefined) return { clause: cardClause, armedBy, waited: true };
  }
  const waitClause = routineCardWaitRefusalClause(outcome, Math.round(budgetMs / 1_000));
  return { clause: (routineCardKeepsStateClause(outcome) ? cardClause : "") + waitClause, waited: true };
}

export function approvalPostDeps(platform: string, authorityContext?: BindableContext): RequestApprovalDeps {
  const poster = cardPosterFor(platform);
  return {
    ...(poster ? { postCard: poster } : {}),
    ...(authorityContext ? { authorityContext } : {}),
  };
}

export function hasApprovalCardPath(platform: string): boolean {
  return platform === "slack" || cardPosterFor(platform) !== undefined;
}

export function isOrgAdminOnlySpendCap(row: PendingActionRow): boolean {
  if (row.kind !== "spend.set" && row.kind !== "spend.clear") return false;
  try {
    const args = JSON.parse(row.argsJson) as { level?: unknown };
    return args.level === "domain" || args.level === "user";
  } catch {
    return false;
  }
}

function roomNamespace(scopeKey: string | undefined | null): { readonly platform: string; readonly tenant: string } | undefined {
  if (!scopeKey) return undefined;
  const parsed = parseScopeKey(scopeKey);
  return parsed.kind === "tenant" || parsed.kind === "surface" ? { platform: parsed.platform, tenant: parsed.workspace } : undefined;
}

export function clickerMayDecide(
  row: PendingActionRow,
  clickerId: string,
  clickerPlatform: string | undefined,
  clickerTenant: string | undefined,
  clickerEnterprise?: string,
): boolean {
  if (!clickerPlatform) return false;
  const domains = getConfig().loadDomains();
  if (tryPrincipalKey(clickerPlatform, clickerTenant, clickerId) === undefined) return false;
  const admits = (roster: readonly string[] | undefined): boolean =>
    rosterHasPrincipal(roster, clickerPlatform, clickerTenant, clickerId, clickerEnterprise);
  if (admits(criteriaDomain("org", domains)?.admins)) return true;
  if (isOrgAdminOnlySpendCap(row)) return false;
  if (!row.domain) return false;
  return admits(domains.find((d) => d.name === row.domain)?.admins);
}

interface BlockActionsPayload {
  readonly actions?: readonly { readonly action_id?: unknown; readonly value?: unknown }[];
  readonly user?: { readonly id?: unknown };
  readonly channel?: { readonly id?: unknown };
  readonly message?: { readonly ts?: unknown };
  readonly team?: { readonly id?: unknown; readonly enterprise_id?: unknown };
  readonly enterprise?: { readonly id?: unknown };
  readonly enterprise_id?: unknown;
}

export interface HandleApprovalDeps {
  readonly post?: PostFn;
  readonly decisionWake?: DecisionWakeDeps;
  readonly clickerIsGuest?: (userId: string, teamId: string | undefined) => Promise<boolean | undefined>;
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

async function updateCard(post: PostFn, channelId: string, ts: string | undefined, card: RenderedCard): Promise<boolean> {
  if (!ts) return false;
  if (swallowRoomOp("a slack approval-card rewrite")) return false;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("ts", ts);
  body.set("text", card.text);
  body.set("blocks", JSON.stringify(card.blocks));
  if (card.metadata) body.set("metadata", JSON.stringify(card.metadata));
  const res = await post("chat.update", body.toString()).catch(() => undefined);
  return res?.ok === true;
}

async function updateCardText(post: PostFn, channelId: string, ts: string | undefined, text: string): Promise<void> {
  if (!ts) return;
  if (swallowRoomOp("a slack approval-card rewrite")) return;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("ts", ts);
  body.set("text", text);
  body.set("blocks", JSON.stringify([{ type: "section", text: { type: "mrkdwn", text } }]));
  await post("chat.update", body.toString());
}

async function postRenderedCard(post: PostFn, channelId: string, threadTs: string | null | undefined, card: RenderedCard): Promise<{ ts?: string; error?: string }> {
  const body = new URLSearchParams();
  body.set("channel", channelId);
  if (threadTs) body.set("thread_ts", threadTs);
  body.set("text", card.text);
  body.set("blocks", JSON.stringify(card.blocks));
  if (card.metadata) body.set("metadata", JSON.stringify(card.metadata));
  const res = await post("chat.postMessage", body.toString());
  if (res?.ok === true && typeof res.ts === "string") return { ts: res.ts };
  if (res && typeof res["error"] === "string") return { error: res["error"] as string };
  if (!res) return { error: "no bot token is configured, or the request never reached the surface" };
  return { error: "the surface accepted the post but named no message id" };
}

const CARD_POST_REASON_KEY = "oeCardPostReason";

export function cardPostFailureReason(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const reason = (err as Record<string, unknown>)[CARD_POST_REASON_KEY];
  return typeof reason === "string" ? reason : undefined;
}

async function postThreadNote(post: PostFn, channelId: string, threadTs: string | undefined, text: string): Promise<void> {
  if (swallowRoomOp("a slack approval thread note")) return;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  if (threadTs) body.set("thread_ts", threadTs);
  body.set("text", text);
  await post("chat.postMessage", body.toString());
}

async function postClickerNote(post: PostFn, channelId: string, threadTs: string | undefined, user: string, text: string): Promise<void> {
  if (swallowRoomOp("a slack approval click note")) return;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("user", user);
  if (threadTs) body.set("thread_ts", threadTs);
  body.set("text", text);
  await post("chat.postEphemeral", body.toString());
}

const MENTION_PLATFORMS: ReadonlySet<string> = new Set(["slack", "discord"]);

export function decisionNoticeText(
  row: Pick<PendingActionRow, "requestedBy" | "scopeKey" | "postedTo">,
  status: PendingStatus,
  clickerId: string | undefined,
  executed: "ok" | "failed" | "none",
  staleCard?: { readonly outcomeLine: string; readonly row: Pick<PendingActionRow, "kind" | "argsJson"> },
): string | undefined {
  const surface = (row.postedTo ?? row.scopeKey).split("/")[0] ?? "";
  if (staleCard !== undefined) {
    const who = MENTION_PLATFORMS.has(surface) && clickerId !== undefined && clickerId !== "system" && /^[\w-]+$/u.test(clickerId) ? `<@${clickerId}>` : "an admin";
    return decidedCardLine({ ...staleCard.row, status }, status === "expired" ? undefined : staleCard.outcomeLine, who);
  }
  if (clickerId !== undefined && clickerId === row.requestedBy) return undefined;
  if (!MENTION_PLATFORMS.has(surface)) return undefined;
  const askerPlatform = row.scopeKey.split("/")[0] ?? "";
  if (askerPlatform !== surface || !/^[\w-]+$/u.test(row.requestedBy)) return undefined;
  const asker = `<@${row.requestedBy}>`;
  const by = clickerId !== undefined && /^[\w-]+$/u.test(clickerId) && clickerId !== "system" ? `<@${clickerId}>` : "an admin";
  if (status === "approved") return executed === "failed" ? `${asker}, ${by} approved your request, but it failed.` : `${asker}, ${by} approved your request.`;
  if (status === "rejected") return `${asker}, ${by} declined your request.`;
  if (status === "expired") return `${asker}, your request expired before anyone answered it.`;
  return undefined;
}

function summaryLinesFor(row: PendingActionRow): string[] {
  const kindDef = actionKind(row.kind);
  if (!kindDef) return [`(no registered ActionKind for "${row.kind}")`];
  try {
    const args = JSON.parse(row.argsJson);
    return kindDef.summarize(args);
  } catch {
    return ["(failed to render this pending's summary)"];
  }
}

export type ApprovalClickResolution =
  | { readonly outcome: "unknown" }
  | { readonly outcome: "not-pending" }
  | { readonly outcome: "expired"; readonly row: PendingActionRow; readonly summaryLines: string[] }
  | { readonly outcome: "expired-race" }
  | { readonly outcome: "unregistered-kind" }
  | { readonly outcome: "denied"; readonly row: PendingActionRow }
  | { readonly outcome: "clicker-denied"; readonly row: PendingActionRow; readonly reason: ClickerFloorRefusal }
  | { readonly outcome: "lost-race" }
  | { readonly outcome: "halted"; readonly row: PendingActionRow; readonly notice: string }
  | {
      readonly outcome: "decided";
      readonly row: PendingActionRow;
      readonly summaryLines: string[];
      readonly outcomeLine: string;
      readonly executed: "ok" | "failed" | "none";
    }
  | {
      readonly outcome: "contradicted";
      readonly row: PendingActionRow;
      readonly summaryLines: string[];
      readonly contradiction: ContradictJudgeAllowOutcome;
    };

export interface ResolveApprovalClickInput {
  readonly org: string;
  readonly id: string;
  readonly decision: ApprovalDecision;
  readonly clickerId: string;
  readonly platformAdmin?: (row: PendingActionRow) => boolean | Promise<boolean>;
  readonly clickContext?: { readonly surfaceKey: string };
  readonly releaseFeedback?: SweepFeedbackDeps;
  readonly clickerPlatform?: string;
  readonly clickerTenant?: string;
  readonly clickerEnterprise?: string;
  readonly clickerIsGuest?: boolean;
  readonly halt?: HaltDeps;
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

async function auditClickerDenial(
  org: string,
  row: PendingActionRow,
  clickerId: string,
  reason: ClickerFloorRefusal | "not-admin" | "halted",
  clickSurfaceKey?: string,
  extraDetail?: AuditDetail,
): Promise<void> {
  await appendAudit({
    ...whereFromScope(org, row.scopeKey),
    principalId: clickerId,
    action: "approval.denied",
    detail: { id: row.id, kind: row.kind, ...venueDetail(row, clickSurfaceKey), reason, ...extraDetail },
  }).catch(() => undefined);
}

export const MAX_SESSION_GRANT_RELEASES = 32;

async function releaseSessionGrantedPendings(input: {
  readonly sessionId: string;
  readonly memoKind: string;
  readonly grantedOn: PendingActionRow;
  readonly click: ResolveApprovalClickInput;
}): Promise<readonly string[]> {
  const org = input.click.org;
  const released: string[] = [];
  try {
    const store = getOperationalStore();
    const matched = (await store.listPendingActions(org)).filter(
      (r) =>
        r.id !== input.grantedOn.id &&
        sessionIdFromFrozenArgs(r.argsJson) === input.sessionId &&
        sessionGrantKind(r) === input.memoKind,
    );
    const candidates = matched.slice(0, MAX_SESSION_GRANT_RELEASES);
    if (matched.length > candidates.length) {
      console.warn(
        `[open-everywhere:approvals] session-grant release capped at ${String(candidates.length)} of ${String(matched.length)} candidate cards (org=${org}); the rest stay pending and clickable`,
      );
    }
    for (const candidate of candidates) {
      const halt = await resolveHalt(
        haltScopeFor({
          org,
          scopeKey: candidate.scopeKey,
          domain: candidate.domain,
          principalId: candidate.requestedBy,
        }),
      ).catch(() => ({ halted: true }) as { readonly halted: boolean });
      if (halt.halted) continue;
      const outcome = await resolveApprovalClick({ ...input.click, id: candidate.id, decision: "approve" });
      if (outcome.outcome !== "decided") continue;
      released.push(candidate.id);
      await rowDecisionFeedback(
        outcome.row ?? candidate,
        {
          summaryLines: outcome.summaryLines ?? summaryLinesFor(candidate),
          outcome: "approved",
          outcomeLine: outcome.outcomeLine ?? "approved",
          executed: outcome.executed ?? "none",
          clickerId: input.click.clickerId,
        },
        input.click.releaseFeedback ?? {},
      ).catch(() => undefined);
    }
    const truncated = matched.length > candidates.length;
    if (released.length > 0 || truncated) {
      await appendAudit({
        ...whereFromScope(org, input.grantedOn.scopeKey),
        principalId: input.click.clickerId,
        action: SESSION_GRANT_RELEASED_ACTION,
        detail: {
          id: input.grantedOn.id,
          memoKind: input.memoKind,
          released,
          ...(truncated ? { candidates: matched.length, cap: MAX_SESSION_GRANT_RELEASES } : {}),
        },
      }).catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[open-everywhere:approvals] session-grant release failed (org=${org}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return released;
}

export const SESSION_GRANT_RELEASED_ACTION = "approval.session_grant_released";

async function runSessionGrantRelease(tail: () => Promise<unknown>, waitUntil: ((p: Promise<unknown>) => void) | undefined): Promise<void> {
  const logFailure = (err: unknown): undefined => {
    console.warn(`[open-everywhere:approvals] session-grant release tail failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  };
  if (waitUntil === undefined) {
    await tail().catch(logFailure);
    return;
  }
  const deferred = tail().catch(logFailure);
  try {
    waitUntil(deferred);
  } catch (err) {
    logFailure(err);
    await deferred;
  }
}

function failedOutcomeLine(err: unknown): string {
  return `${FAILED_OUTCOME_PREFIX} ${auditErrorDetail(err).error}`;
}

export async function resolveApprovalClick(input: ResolveApprovalClickInput): Promise<ApprovalClickResolution> {
  const store = getOperationalStore();
  const row = await store.getPendingAction(input.org, input.id);

  if (!row) return { outcome: "unknown" };

  const contradicting = input.decision === "contradict";
  if (!contradicting && row.status !== "pending") return { outcome: "not-pending" };

  if (!contradicting && row.kind !== HALT_LIFT_ACTION_KIND) {
    const haltState = await resolveHalt(
      haltScopeFor({
        org: input.org,
        scopeKey: row.scopeKey,
        domain: row.domain,
        ...(row.requestedBy ? { principalId: row.requestedBy } : {}),
      }),
      input.halt ?? {},
    );
    if (haltState.halted) {
      await auditClickerDenial(input.org, row, input.clickerId, "halted", undefined, haltAuditDetail(haltState));
      emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "halted" });
      return { outcome: "halted", row, notice: haltClickNotice(haltState) };
    }
  }

  const nowIso = new Date().toISOString();
  if (!contradicting && Date.parse(row.expiresAt) <= Date.now()) {
    const cas = await closePendingAction(store, input.org, row, "expired", "system", nowIso);
    if (!cas) return { outcome: "expired-race" };
    const expiredRow: PendingActionRow = { ...row, status: "expired", decidedBy: "system", decidedAt: nowIso };
    await appendAudit({
      ...whereFromScope(input.org, row.scopeKey),
      principalId: "system",
      action: "approval.expired",
      detail: { id: row.id, kind: row.kind, cause: "ttl" },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "expired" });
    return { outcome: "expired", row: expiredRow, summaryLines: summaryLinesFor(expiredRow) };
  }

  const kindDef = actionKind(row.kind);
  if (!kindDef) {
    console.error(`[open-everywhere:approvals] no registered ActionKind for "${row.kind}" (pending ${row.id}) — cannot decide`);
    return { outcome: "unregistered-kind" };
  }

  if (input.clickContext) {
    const { surfaceKey } = input.clickContext;
    if (!clickRoomMatches(row, surfaceKey)) {
      await auditClickerDenial(input.org, row, input.clickerId, "foreign-room");
      return { outcome: "clicker-denied", row, reason: "foreign-room" };
    }
    if (kindDef.policy === "member") {
      const verdict = await checkClickerFloor(surfaceKey, {
        beneficiaryClicker: kindDef.beneficiaryClicker === true,
        clickerIsGuest: input.clickerIsGuest,
      });
      if (!verdict.ok) {
        await auditClickerDenial(input.org, row, input.clickerId, verdict.reason, surfaceKey);
        return { outcome: "clicker-denied", row, reason: verdict.reason };
      }
    }
  }

  const clickerRoom = roomNamespace(input.clickContext?.surfaceKey) ?? roomNamespace(row.postedTo);
  const clickerPlatform = input.clickerPlatform ?? clickerRoom?.platform;
  const clickerTenant = input.clickerTenant ?? clickerRoom?.tenant;
  if (kindDef.policy === "admin" && !clickerMayDecide(row, input.clickerId, clickerPlatform, clickerTenant, input.clickerEnterprise) && (await input.platformAdmin?.(row)) !== true) {
    await auditClickerDenial(input.org, row, input.clickerId, "not-admin", input.clickContext?.surfaceKey);
    return { outcome: "denied", row };
  }

  const venue = venueDetail(row, input.clickContext?.surfaceKey);

  if (contradicting) {
    const res = await contradictJudgeAllow({ org: input.org, id: row.id, principalId: input.clickerId, route: "click", venue });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_judge_contradicted", "oe.outcome": res.outcome });
    return { outcome: "contradicted", row, summaryLines: summaryLinesFor(row), contradiction: res.outcome };
  }

  const allowRule: AllowRulePlan | undefined =
    input.decision === "approve_rule"
      ? await planAllowRuleClick(row, {
          clickerId: input.clickerId,
          ...(input.clickContext ? { clickSurfaceKey: input.clickContext.surfaceKey } : {}),
          ...(input.clickerIsGuest !== undefined ? { clickerIsGuest: input.clickerIsGuest } : {}),
        })
      : undefined;

  const status = input.decision === "reject" ? "rejected" : "approved";
  const cas = await store.decidePendingAction(input.org, row.id, status, input.clickerId, nowIso);
  if (!cas) return { outcome: "lost-race" };

  const decidedRow: PendingActionRow = { ...row, status, decidedBy: input.clickerId, decidedAt: nowIso };
  const summaryLines = summaryLinesFor(decidedRow);

  if (status === "rejected") {
    await applyArgsAfterClose(store, input.org, row);
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.rejected", detail: { id: row.id, kind: row.kind, ...venue } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "rejected" });
    let outcomeLine = "rejected";
    if (kindDef.declined) {
      outcomeLine = await kindDef.declined(JSON.parse(row.argsJson) as unknown, input.clickerId).catch(async (err: unknown) => {
        const error = auditErrorDetail(err).error;
        console.warn(`[open-everywhere:approvals] the decline of ${row.kind} ${row.id} was not saved: ${error}`);
        await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.failed", detail: { id: row.id, kind: row.kind, ...venue, phase: "decline", error } }).catch(() => undefined);
        return failedOutcomeLine(err);
      });
    }
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine, executed: "none" };
  }

  let releaseTail: (() => Promise<unknown>) | undefined;

  if (input.decision === "approve_session") {
    const memoKind = sessionGrantKind(row);
    const sessionId = grantableFrozenKey(row);
    if (memoKind && sessionId) {
      const expiresAt = new Date(Date.parse(nowIso) + getSettings().approvals.routineGrantTtlHours * 3_600_000).toISOString();
      await store.setSessionApproval({ org: input.org, sessionId, kind: memoKind, grantedBy: input.clickerId, createdAt: nowIso, expiresAt }).catch(() => {});
      await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.session_granted", detail: { id: row.id, kind: row.kind, memoKind, reach: grantReach(sessionId), ...venue } }).catch(() => undefined);
      releaseTail = () => releaseSessionGrantedPendings({ sessionId, memoKind, grantedOn: row, click: input });
    }
  }

  const withRuleLine = async (line: string): Promise<string> => {
    if (allowRule === undefined) return line;
    if (!allowRule.ok) {
      await auditAllowRuleRefused(row, input.clickerId, allowRule.reason, venue);
      return `${line} · ${allowRule.why}`;
    }
    return `${line} · ${await applyAllowRule(allowRule, row, input.clickerId, venue)}`;
  };

  try {
    const args = JSON.parse(row.argsJson) as unknown;
    const outcome = await withArmingApproval({ id: row.id, kind: row.kind }, () => kindDef.execute(args, input.clickerId));
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.approved", detail: { id: row.id, kind: row.kind, ...venue, outcome: scrubAuditText(outcome) } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "approved" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: await withRuleLine(outcome), executed: "ok" };
  } catch (err) {
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.failed", detail: { id: row.id, kind: row.kind, ...venue, ...auditErrorDetail(err) } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "failed" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: await withRuleLine(failedOutcomeLine(err)), executed: "failed" };
  } finally {
    if (releaseTail) await runSessionGrantRelease(releaseTail, input.waitUntil);
  }
}

export interface SweepFeedbackDeps {
  readonly post?: PostFn;
  readonly discordNotice?: (row: PendingActionRow, text: string) => Promise<unknown>;
  readonly decisionWake?: DecisionWakeDeps;
}

async function sweepExpiryFeedback(row: PendingActionRow, deps: SweepFeedbackDeps): Promise<void> {
  await rowDecisionFeedback(row, { summaryLines: summaryLinesFor(row), outcome: "expired", outcomeLine: "expired", executed: "none" }, deps);
}

async function rowDecisionFeedback(
  row: PendingActionRow,
  what: Pick<DecisionFeedbackInput, "summaryLines" | "outcome" | "outcomeLine" | "executed"> & { readonly clickerId?: string },
  deps: SweepFeedbackDeps = {},
): Promise<void> {
  if (!row.postedTo) return;
  const [platform, workspace] = row.postedTo.split("/");
  if (!workspace) return;
  const post = deps.post ?? bridgeSlackForm;
  if (platform !== "slack" && platform !== "discord") {
    const surface = decisionFeedbackSurfaceFor(platform);
    if (!surface) return;
    await deliverDecisionFeedback(
      { row, ...what, target: await surface.wakeTarget(row).catch(() => null), cardShowsOutcome: false, noticeThread: null, postNotice: (text) => surface.postNotice(row, text) },
      deps.decisionWake,
    );
    return;
  }
  let cardRedrawn = false;
  if (platform === "slack" && row.messageTs) {
    cardRedrawn = await decidedRenderFor(row, what.summaryLines, what.outcomeLine, row.channelId, row.messageTs)
      .then((card) => updateCard(post, row.channelId, row.messageTs ?? undefined, card))
      .catch(() => false);
  }
  const postNotice =
    platform === "slack"
      ? (text: string) => postThreadNote(post, row.channelId, row.threadTs ?? row.messageTs ?? undefined, text)
      : (text: string) => (deps.discordNotice ?? postDiscordDecisionNotice)(row, text);
  await deliverDecisionFeedback(
    {
      row,
      ...what,
      target: platform === "slack" ? slackDecisionWakeTarget(row, workspace) : discordDecisionWakeTarget(row, workspace),
      cardShowsOutcome: cardRedrawn,
      noticeThread: cardRedrawn ? slackNoticeThread(row.channelId, row.threadTs ?? row.messageTs ?? undefined) : null,
      postNotice,
    },
    deps.decisionWake,
  );
}

export async function sweepExpiredPendings(org: string, now: Date = new Date(), deps: SweepFeedbackDeps = {}): Promise<number> {
  const store = getOperationalStore();
  const nowIso = now.toISOString();
  const expired = await store.listExpiredPendingActions(org, nowIso);
  let count = 0;
  for (const row of expired) {
    try {
      const won = await closePendingAction(store, org, row, "expired", "system", nowIso);
      if (!won) continue;
      await appendAudit({
        ...whereFromScope(org, row.scopeKey),
        principalId: "system",
        action: "approval.expired",
        detail: { id: row.id, kind: row.kind, cause: "ttl" },
      });
      count++;
      await sweepExpiryFeedback({ ...row, status: "expired", decidedBy: "system", decidedAt: nowIso }, deps);
    } catch (err) {
      console.warn(`[open-everywhere:approvals] sweepExpiredPendings: failed to expire ${row.id}: ${String(err)}`);
    }
  }
  return count + (await reapSupersededRoutineCards(org, now, deps));
}

export async function reapSupersededRoutineCards(org: string, now: Date = new Date(), deps: SweepFeedbackDeps = {}): Promise<number> {
  const store = getOperationalStore();
  const nowIso = now.toISOString();
  const pending = await store.listPendingActions(org).catch(() => [] as readonly PendingActionRow[]);
  let count = 0;
  for (const row of pending) {
    if (row.kind === ROUTINE_ATTENTION_KIND) {
      count += await reapSupersededCheckInCard(store, org, row, nowIso, deps);
      continue;
    }
    if (row.kind !== ROUTINE_PERMISSION_KIND) continue;
    const args = parseRoutinePermissionArgs(row.argsJson);
    if (!args) continue;
    try {
      const state = await routineCardGenerationState(args);
      if (state.state === "current" || state.state === "unreadable") continue;
      const won = await store.decidePendingAction(org, row.id, "expired", "system", nowIso);
      if (!won) continue;
      await appendAudit({
        ...whereFromScope(org, row.scopeKey),
        principalId: "system",
        action: "approval.expired",
        detail: { id: row.id, kind: row.kind, cause: state.state === "gone" ? "routine-deleted" : "routine-superseded", routine: args.routineId },
      });
      count++;
      await sweepExpiryFeedback({ ...row, status: "expired", decidedBy: "system", decidedAt: nowIso }, deps);
    } catch (err) {
      console.warn(`[open-everywhere:approvals] reapSupersededRoutineCards: failed to expire ${row.id}: ${String(err)}`);
    }
  }
  return count;
}

async function reapSupersededCheckInCard(
  store: ReturnType<typeof getOperationalStore>,
  org: string,
  row: PendingActionRow,
  nowIso: string,
  deps: SweepFeedbackDeps,
): Promise<number> {
  try {
    if (Date.parse(nowIso) - Date.parse(row.createdAt) < 2 * DISPATCH_TICK_MINUTES * 60_000) return 0;
    const args = JSON.parse(row.argsJson) as Partial<RoutineAttentionArgs>;
    if (typeof args.org !== "string" || typeof args.surfaceKey !== "string" || typeof args.routineId !== "string") return 0;
    const routine = await getRoutine(args.org, args.surfaceKey, args.routineId);
    if (routine !== null && routine.attention?.cardId === row.id) return 0;
    const won = await store.decidePendingAction(org, row.id, "expired", "system", nowIso);
    if (!won) return 0;
    await appendAudit({
      ...whereFromScope(org, row.scopeKey),
      principalId: "system",
      action: "approval.expired",
      detail: { id: row.id, kind: row.kind, cause: routine === null ? "routine-deleted" : "routine-superseded", routine: args.routineId },
    });
    await sweepExpiryFeedback({ ...row, status: "expired", decidedBy: "system", decidedAt: nowIso }, deps);
    return 1;
  } catch (err) {
    console.warn(`[open-everywhere:approvals] reapSupersededCheckInCard: failed to expire ${row.id}: ${String(err)}`);
    return 0;
  }
}

export interface DecisionWakeDeps {
  readonly dispatch?: typeof dispatchApprovalDecisionWake;
  readonly now?: () => string;
  readonly mintWakeId?: () => string;
}

function isOwnDmSeatToken(token: string, surfaceKey: string): boolean {
  return isDmAnchorWindowToken(token) && dmAnchorSurfaceForToken(token) === surfaceKey;
}

async function decisionWakeSeatFor(org: string, surfaceKey: string, opts: { readonly dmOnly?: boolean } = {}): Promise<{ readonly domainName: string; readonly token: string } | null> {
  const store = getOperationalStore();
  let dmKey: { readonly domainName: string; readonly registryKey: string } | undefined;
  try {
    dmKey = { domainName: dmAnchorDomain(surfaceKey), registryKey: dmWindowRegistryKey(surfaceKey) };
  } catch {
    dmKey = undefined;
  }
  if (dmKey) {
    const dm = await store.getChannelSession(org, dmKey.registryKey).catch(() => null);
    if (dm) return isOwnDmSeatToken(dm.token, surfaceKey) ? { domainName: dmKey.domainName, token: dm.token } : null;
  }
  if (opts.dmOnly) return null;
  let grain: ReturnType<typeof supervisorGrainFor>;
  try {
    grain = supervisorGrainFor(surfaceKey, getConfig().loadDomains());
  } catch {
    return null;
  }
  if (!grainUsesUnifiedWindow(grain) || grain.domainName === undefined) return null;
  const session = await store.getChannelSession(org, grain.registryKey).catch(() => null);
  return session ? { domainName: grain.domainName, token: session.token } : null;
}

function armedCallReplayOf(row: PendingActionRow): { replay?: { connection: string; tool: string } } {
  const kindDef = actionKind(row.kind);
  if (kindDef?.approvalArmsCall !== true || kindDef.armedCallReplay === undefined) return {};
  try {
    const target = kindDef.armedCallReplay(JSON.parse(row.argsJson));
    return target === undefined ? {} : { replay: { connection: target.connection, tool: target.tool } };
  } catch {
    return {};
  }
}

export async function wakeWindowOnDecision(
  input: {
    readonly row: PendingActionRow;
    readonly outcome: ApprovalOutcome;
    readonly summaryLine: string;
    readonly clickerId?: string;
    readonly execution?: { readonly ran: "ok" | "failed"; readonly line: string };
    readonly surfaceKey: string;
    readonly origin: UnifiedWakeOrigin;
  },
  deps: DecisionWakeDeps = {},
): Promise<boolean> {
  const dispatch = deps.dispatch ?? dispatchApprovalDecisionWake;
  const mint = deps.mintWakeId ?? mintWakeId;
  const nowIso = (deps.now ?? (() => new Date().toISOString()))();

  const authority = await readApprovalDecisionAuthority(input.row.org, input.row.id);
  if (isDiscordDmOrigin(input.origin) && !(authority && isDiscordDmOrigin(authority.origin) && authority.origin.channelId === input.origin.channelId && authority.surfaceKey === input.surfaceKey)) {
    return false;
  }
  const surfaceKey = authority?.surfaceKey ?? input.surfaceKey;
  const origin = authority?.origin ?? input.origin;

  const teamsChat = origin.platform === "teams" && authority !== undefined && authority.binding.mode !== "channel";
  const seat = await decisionWakeSeatFor(input.row.org, surfaceKey, { dmOnly: isDiscordDmOrigin(origin) || teamsChat });
  if (!seat) return false;
  const { domainName } = seat;

  const wakeId = mint();
  const message = renderApprovalDecisionMessage(
    {
      origin,
      wakeId,
      summaryLine: input.summaryLine,
      outcome: input.outcome,
      ...(input.clickerId ? { clickerId: input.clickerId } : {}),
      ...(input.execution ? { execution: input.execution } : {}),
      pendingId: input.row.id,
      ...(seatTokenForwardsWork(seat.token) ? { forwardsWork: true } : {}),
      ...(actionKind(input.row.kind)?.approvalArmsCall === true ? { armsCall: true } : {}),
      ...armedCallReplayOf(input.row),
    },
    nowIso,
  );
  const delivered = await dispatch({
    token: seat.token,
    origin,
    wakeId,
    message,
    domain: domainName,
    ...(authority
      ? {
          binding: authority.binding,
          requester: authority.requester,
          nonMemberWake: authority.nonMemberWake,
        }
      : {}),
  }).catch(() => false);

  await appendAudit({
    ...whereFromScope(input.row.org, input.row.scopeKey),
    principalId: input.clickerId ?? "system",
    action: "approval.decision_wake",
    detail: { id: input.row.id, kind: input.row.kind, outcome: input.outcome, domain: domainName, delivered, wakeId },
  }).catch(() => undefined);
  return delivered;
}

function slackNoticeThread(channelId: string, threadTs: string | undefined): UnifiedWakeOrigin | null {
  return threadTs ? { platform: "slack", channelId, threadTs } : null;
}

function slackDecisionWakeTarget(row: PendingActionRow, teamId: string | undefined): { surfaceKey: string; origin: UnifiedWakeOrigin } | null {
  if (!teamId) return null;
  return {
    surfaceKey: `slack/${teamId}/${row.channelId}`,
    origin: { platform: "slack", channelId: row.channelId, ...(row.threadTs ? { threadTs: row.threadTs } : {}) },
  };
}

export function discordDecisionWakeTarget(row: PendingActionRow, guildId: string | undefined): { surfaceKey: string; origin: UnifiedWakeOrigin } | null {
  if (guildId) {
    return {
      surfaceKey: `discord/${guildId}/${row.channelId}`,
      origin: { platform: "discord", channelId: row.channelId, guildId, ...(row.messageTs ? { messageId: row.messageTs } : {}) },
    };
  }
  const dmSurfaceKey = discordDmCardSurfaceKey(row);
  if (!dmSurfaceKey) return null;
  return { surfaceKey: dmSurfaceKey, origin: { platform: "discord", channelId: row.channelId, dm: true } };
}

function isDiscordDmOrigin(origin: UnifiedWakeOrigin): origin is Extract<UnifiedWakeOrigin, { readonly platform: "discord"; readonly dm: true }> {
  return origin.platform === "discord" && "dm" in origin && origin.dm === true;
}

function discordDmCardSurfaceKey(row: PendingActionRow): string | undefined {
  const parts = row.postedTo?.split("/");
  if (!parts || parts.length !== 3) return undefined;
  const [platform, workspace, channel] = parts;
  if (platform !== "discord" || !workspace || !row.channelId || channel !== row.channelId) return undefined;
  return row.postedTo ?? undefined;
}

export function postDiscordDecisionNotice(row: PendingActionRow, text: string): Promise<unknown> {
  const ops = surfaceMessageOps("discord");
  if (!ops) return Promise.resolve(undefined);
  return ops.postText(row.channelId, text, row.messageTs ? { replyToMessageId: row.messageTs } : undefined);
}

export interface DecisionFeedbackInput {
  readonly row: PendingActionRow;
  readonly summaryLines: string[];
  readonly outcome: ApprovalOutcome;
  readonly outcomeLine: string;
  readonly executed: "ok" | "failed" | "none";
  readonly clickerId?: string;
  readonly target: { surfaceKey: string; origin: UnifiedWakeOrigin } | null;
  readonly cardShowsOutcome: boolean;
  readonly noticeThread: UnifiedWakeOrigin | null;
  readonly postNotice: (text: string) => Promise<unknown>;
}

async function threadOwnedBySession(org: string, origin: UnifiedWakeOrigin | null): Promise<boolean> {
  if (origin === null) return true;
  try {
    const ref = unifiedThreadRef(origin);
    return (await getOperationalStore().getThreadOwner(org, ref.channelKey, ref.threadKey)) !== null;
  } catch {
    return true;
  }
}

export async function deliverDecisionFeedback(input: DecisionFeedbackInput, decisionWake?: DecisionWakeDeps): Promise<void> {
  const sessionless = actionKind(input.row.kind)?.sessionless === true;
  let woke = false;
  if (input.target && !sessionless) {
    woke = await wakeWindowOnDecision(
      {
        row: input.row,
        outcome: input.outcome,
        summaryLine: input.summaryLines[0] ?? "the requested change",
        ...(input.clickerId ? { clickerId: input.clickerId } : {}),
        ...(input.executed === "none" ? {} : { execution: { ran: input.executed, line: input.outcomeLine } }),
        surfaceKey: input.target.surfaceKey,
        origin: input.target.origin,
      },
      decisionWake,
    ).catch(() => false);
  }
  if (sessionless && input.cardShowsOutcome) return;
  const statesOutcome = !input.cardShowsOutcome || !woke || (await threadOwnedBySession(input.row.org, input.noticeThread));
  const notice = decisionNoticeText(input.row, input.outcome, input.clickerId, input.executed, statesOutcome ? { outcomeLine: input.outcomeLine, row: input.row } : undefined);
  if (notice !== undefined && !swallowRoomOp(`an approval decision notice (${input.outcome})`)) {
    await input.postNotice(notice).catch(() => undefined);
  }
}

export async function handleApprovalPayload(payload: unknown, deps: HandleApprovalDeps = {}): Promise<boolean> {
  const p = payload as BlockActionsPayload | null | undefined;
  const action = p?.actions?.[0];
  const actionId = typeof action?.action_id === "string" ? action.action_id : undefined;
  if (actionId === undefined) return false;

  const parsed = parseApprovalAction(actionId);
  if (!parsed) return false;

  const post = deps.post ?? bridgeSlackForm;

  try {
    const org = typeof action?.value === "string" ? action.value : undefined;
    const clickerId = typeof p?.user?.id === "string" ? p.user.id : undefined;
    const channelId = typeof p?.channel?.id === "string" ? p.channel.id : undefined;
    const messageTs = typeof p?.message?.ts === "string" ? p.message.ts : undefined;
    const teamId = typeof p?.team?.id === "string" ? p.team.id : undefined;
    const gridOf = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
    const enterpriseId = gridOf(p?.enterprise?.id) ?? gridOf(p?.enterprise_id) ?? gridOf(p?.team?.enterprise_id);

    if (!org || !clickerId || !channelId) {
      console.error(`[open-everywhere:approvals] malformed block_actions payload for "${actionId}" — missing org/user/channel; ignoring the click`);
      return true;
    }

    const clickerIsGuest = deps.clickerIsGuest ? await deps.clickerIsGuest(clickerId, teamId).catch(() => undefined) : undefined;

    const res = await resolveApprovalClick({
      org,
      id: parsed.id,
      decision: parsed.decision,
      clickerId,
      clickerPlatform: "slack",
      ...(enterpriseId === undefined ? {} : { clickerEnterprise: enterpriseId }),
      ...(teamId ? { clickContext: { surfaceKey: `slack/${teamId}/${channelId}` } } : {}),
      ...(clickerIsGuest === undefined ? {} : { clickerIsGuest }),
      ...(deps.waitUntil ? { waitUntil: deps.waitUntil } : {}),
    });
    switch (res.outcome) {
      case "unknown":
        if (parsed.decision === "contradict") {
          await postClickerNote(post, channelId, messageTs, clickerId, judgeContradictionNotice("unknown"));
          return true;
        }
        if (await messageHostsOtherRows(org, channelId, messageTs, parsed.id)) {
          await postClickerNote(post, channelId, messageTs, clickerId, CLICK_NOTICE.unknownItem);
          return true;
        }
        await updateCardText(post, channelId, messageTs, CLICK_NOTICE.unknown);
        return true;
      case "not-pending":
        await redrawGroupedCard(post, org, channelId, messageTs);
        return true;
      case "expired-race":
      case "unregistered-kind":
      case "lost-race":
        return true;
      case "expired": {
        const edited = await updateCard(post, channelId, messageTs, await decidedRenderFor(res.row, res.summaryLines, "expired", channelId, messageTs));
        await deliverDecisionFeedback(
          {
            row: res.row,
            summaryLines: res.summaryLines,
            outcome: "expired",
            outcomeLine: "expired",
            executed: "none",
            target: slackDecisionWakeTarget(res.row, teamId),
            cardShowsOutcome: edited,
            noticeThread: slackNoticeThread(channelId, res.row.threadTs ?? messageTs),
            postNotice: (text) => postThreadNote(post, channelId, res.row.threadTs ?? messageTs, text),
          },
          deps.decisionWake,
        );
        return true;
      }
      case "denied":
        await postClickerNote(post, channelId, res.row.threadTs ?? messageTs, clickerId, CLICK_NOTICE.denied);
        return true;
      case "clicker-denied":
        await postClickerNote(post, channelId, res.row.threadTs ?? messageTs, clickerId, clickerFloorRefusalNotice(res.reason));
        return true;
      case "halted":
        await postClickerNote(post, channelId, res.row.threadTs ?? messageTs, clickerId, res.notice);
        return true;
      case "contradicted": {
        await postClickerNote(post, channelId, res.row.threadTs ?? messageTs, clickerId, judgeContradictionNotice(res.contradiction));
        return true;
      }
      case "decided": {
        const edited = await updateCard(post, channelId, messageTs, await decidedRenderFor(res.row, res.summaryLines, res.outcomeLine, channelId, messageTs));
        await deliverDecisionFeedback(
          {
            row: res.row,
            summaryLines: res.summaryLines,
            outcome: res.row.status as ApprovalOutcome,
            outcomeLine: res.outcomeLine,
            executed: res.executed,
            clickerId,
            target: slackDecisionWakeTarget(res.row, teamId),
            cardShowsOutcome: edited,
            noticeThread: slackNoticeThread(channelId, res.row.threadTs ?? messageTs),
            postNotice: (text) => postThreadNote(post, channelId, res.row.threadTs ?? messageTs, text),
          },
          deps.decisionWake,
        );
        return true;
      }
    }
  } catch (err) {
    console.error(`[open-everywhere:approvals] handleApprovalPayload failed softly for "${actionId}": ${String(err)}`);
    return true;
  }
}
