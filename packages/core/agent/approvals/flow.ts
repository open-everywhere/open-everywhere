import { createHash, randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { swallowRoomOp, swallowRoomPost } from "../channels/egress-spoof.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { criteriaDomain } from "../memory/domain.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { grainUsesUnifiedWindow, supervisorGrainFor } from "../channels/unified-supervisor.js";
import { mintWakeId, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { dispatchApprovalDecisionWake } from "../channels/unified.js";
import { surfaceMessageOps } from "../channels/surface-message-ops.js";
import { renderApprovalDecisionMessage, type ApprovalOutcome } from "./decision-wake.js";
import { actionKind, whereFromScope } from "./actions.js";
import {
  approvalModeForDomain,
  approversForScopeKey,
  chainAuditDetail,
  preApprovalRulesForScopeKey,
  resolveApproverChain,
  toolForActionKind,
  type ApprovalChainRequest,
} from "../access/approver-chain.js";
import { shadowJudgeAuditDetail } from "../access/approval-judge.js";
import { parseScopeKey, platformOfScopeKey } from "../access/scope-key.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { checkClickerFloor, clickRoomMatches, clickerFloorRefusalNotice, type ClickerFloorRefusal } from "./clicker-floor.js";
import { checkCardDisclosure, cardDisclosureRefusalNotice } from "./card-disclosure.js";
import { pendingCardBlocks, decidedCardBlocks, judgeLiftNoticeBlocks, type RenderedCard } from "./card.js";
import { contradictJudgeAllow, judgeContradictionNotice, type ContradictJudgeAllowOutcome } from "./judge-contradiction.js";
import { describeDeclaredPermissionKind, sessionGrantKind } from "./session-grant.js";
import {
  consumeCardPostedThisTurn,
  markCardPostedThisTurn,
  noteRoutineRunPermissionRefusal,
  peekCardPostedThisTurn,
} from "./card-signal.js";
import { withTaintDisclosure } from "./taint-disclosure.js";
import { withArmingApproval } from "./arming-context.js";
import { getSettings } from "../settings/settings.js";
import type { PendingActionRow, PendingStatus } from "./types.js";
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
import "./agent-create.js";
import "./ticket-actions.js";
import "./ticket-create.js";
import "./chat-post.js";
import "./chat-dm.js";
import "./session-checkpoint.js";
import { ROUTINE_PERMISSION_KIND, parseRoutinePermissionArgs, routineCardGenerationState } from "./routine-permission.js";
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

export const OE_APPROVAL_PREFIX = "oe_approval:";

type PostFn = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export type ApprovalDecision = "approve" | "reject" | "approve_session" | "contradict";

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["approve", "reject", "approve_session", "contradict"];

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

function sessionApprovalTtlHours(): number {
  return getSettings().approvals.sessionTtlHours;
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

export type JudgeLiftNoticePoster = (row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string) => Promise<void>;

const JUDGE_LIFT_NOTICE_POSTERS = new Map<string, JudgeLiftNoticePoster>();

export function registerJudgeLiftNoticePoster(platform: string, poster: JudgeLiftNoticePoster): void {
  if (!admitProviderRegistration(platform, "judge-lift-notice-poster")) return;
  JUDGE_LIFT_NOTICE_POSTERS.set(platform, poster);
}

export function judgeLiftNoticePosterFor(platform: string | undefined): JudgeLiftNoticePoster | undefined {
  return platform === undefined ? undefined : JUDGE_LIFT_NOTICE_POSTERS.get(platform);
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
  const hex = createHash("sha256").update(material).digest("hex");
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
}

export async function requestApproval(
  input: RequestApprovalInput,
  deps: RequestApprovalDeps = {},
): Promise<RequestApprovalResult> {
  const kindDef = actionKind(input.kind);
  if (!kindDef) {
    throw new Error(`requestApproval: no registered ActionKind for "${input.kind}"`);
  }

  const chainTool = toolForActionKind(input.kind);
  if (chainTool !== undefined) {
    const chainReq: ApprovalChainRequest = {
      tool: chainTool,
      action: input.kind,
      args: input.args,
      scopeKey: input.scopeKey,
      ...(input.domain != null ? { domain: input.domain } : {}),
      org: input.org,
      principalId: input.requestedBy,
      unattended: input.chain?.unattended ?? true,
      ...(input.chain?.tainted !== undefined ? { tainted: input.chain.tainted } : {}),
      ...(input.domain != null ? { mode: approvalModeForDomain(input.domain) } : {}),
      ...(kindDef.beneficiaryClicker === true ? { beneficiaryClicker: true } : {}),
    };
    const resolution = await resolveApproverChain(chainReq, {
      approvers: approversForScopeKey(input.scopeKey, input.domain ?? undefined),
      rules: preApprovalRulesForScopeKey(input.scopeKey, input.domain ?? undefined),
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
          ...(input.domain != null ? { domain: input.domain } : {}),
        },
      }).catch(() => undefined);
    }

    void shadowJudgeAuditDetail(chainReq, resolution)
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
      const taintedDeny = resolution.tainted && reason === "ask-unattended";
      const card: RoutinePermissionCardOutcome =
        reason === "ask-unattended"
          ? await offerRoutinePermissionCardForProposal(input, { tainted: resolution.tainted, deps })
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
            taintedDeny
              ? "This turn read external content, so this action needs a person to confirm it — and this run is unattended, so there is nobody to ask. No standing grant lifts that; ask a person to do this, or raise it again in a turn that has not read anything external."
              : reason === "ask-unattended"
                ? card.waited === true
                  ?
                    "Arm the permission on the routine's creation card, or ask a person to do this."
                  : "An unattended run cannot wait on an approval card; arm the permission on the routine's creation card, or ask a person to do this."
                : "This refusal is config-reviewed policy; a config diff to the denying element is the only way to lift it."
          }${card.clause}`,
      );
    }

    if (resolution.verdict === "allow" && resolution.registryVerdict === "ask") {
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
      const noticePoster = judgeLiftNoticePosterFor(noticePlatform);
      if ((noticePlatform === "slack" || noticePoster) && !swallowRoomOp(`a judge-lift notice for "${input.kind}" (${input.scopeKey})`)) {
        try {
          const noticeLines = withTaintDisclosure(input.summaryLines ? [...input.summaryLines] : kindDef.summarize(input.args), input.args);
          if (noticePoster) await noticePoster(row, noticeLines, outcome);
          else await postRenderedCard(deps.post ?? bridgeSlackForm, input.channelId, input.threadTs, judgeLiftNoticeBlocks(row, noticeLines, outcome));
        } catch {
        }
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
      throw new Error(cardDisclosureRefusalNotice());
    }
  }

  const post = deps.post ?? bridgeSlackForm;
  const store = getOperationalStore();

  const now = new Date();
  const expiresAt = input.noClockExpiry ? ROUTINE_PERMISSION_NO_EXPIRY : new Date(now.getTime() + approvalTtlHours() * 3_600_000).toISOString();
  const argsJson = JSON.stringify(input.args ?? null);

  const nowIso = now.toISOString();
  const dup = (await store.listPendingActions(input.org)).find(
    (r) => r.kind === input.kind && r.scopeKey === input.scopeKey && r.channelId === input.channelId && r.argsJson === argsJson && r.expiresAt > nowIso,
  );
  if (dup) {
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "deduped" });
    return { id: dup.id, expiresAt: dup.expiresAt, deduped: true };
  }

  const row: PendingActionRow = {
    id: randomUUID(),
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

  await store.addPendingAction(row);

  const summaryLines = withTaintDisclosure(input.summaryLines ? [...input.summaryLines] : kindDef.summarize(input.args), input.args);

  let messageTs = swallowRoomPost(`an approval-card post for "${input.kind}" (${input.scopeKey})`, "card");
  if (messageTs === undefined) {
    messageTs = deps.postCard
      ? await deps.postCard(row, summaryLines)
      : await postRenderedCard(post, input.channelId, input.threadTs, pendingCardBlocks(row, summaryLines));
  }

  if (!messageTs) {
    await store.decidePendingAction(input.org, row.id, "expired", "system", new Date().toISOString()).catch(() => {});
    await appendAudit({
      ...whereFromScope(input.org, input.scopeKey),
      principalId: input.requestedBy,
      action: "approval.expired",
      detail: { id: row.id, kind: input.kind, cause: "card_post_failed" },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "failed" });
    throw new Error(`requestApproval: failed to post the approval card for "${input.kind}" (${input.scopeKey}) — marked expired, nothing is awaiting a click.`);
  }

  await store.setPendingActionMessage(input.org, row.id, messageTs);
  markCardPostedThisTurn();
  await appendAudit({
    ...whereFromScope(input.org, input.scopeKey),
    principalId: input.requestedBy,
    action: "approval.requested",
    detail: { id: row.id, kind: input.kind, scopeKey: input.scopeKey, ...(row.domain ? { domain: row.domain } : {}) },
  });
  emitTelemetry("oe.feature.used", { "oe.feature": "approval_requested", "oe.outcome": "ok" });

  return { id: row.id, expiresAt };
}

async function offerRoutinePermissionCardForProposal(
  input: RequestApprovalInput,
  ctx: { readonly tainted: boolean; readonly deps: RequestApprovalDeps },
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
      tainted: ctx.tainted,
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
      tainted: offer.tainted,
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

export function approvalPostDeps(platform: string): RequestApprovalDeps {
  const poster = cardPosterFor(platform);
  return poster ? { postCard: poster } : {};
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
): boolean {
  if (!clickerPlatform) return false;
  const domains = getConfig().loadDomains();
  const key = tryPrincipalKey(clickerPlatform, clickerTenant, clickerId);
  if (key === undefined) return false;
  if (criteriaDomain("org", domains)?.admins?.includes(key) === true) return true;
  if (isOrgAdminOnlySpendCap(row)) return false;
  if (!row.domain) return false;
  const explicit = domains.find((d) => d.name === row.domain);
  return explicit?.admins?.includes(key) === true;
}

interface BlockActionsPayload {
  readonly actions?: readonly { readonly action_id?: unknown; readonly value?: unknown }[];
  readonly user?: { readonly id?: unknown };
  readonly channel?: { readonly id?: unknown };
  readonly message?: { readonly ts?: unknown };
  readonly team?: { readonly id?: unknown };
}

export interface HandleApprovalDeps {
  readonly post?: PostFn;
  readonly decisionWake?: DecisionWakeDeps;
  readonly clickerIsGuest?: (userId: string, teamId: string | undefined) => Promise<boolean | undefined>;
}

async function updateCard(post: PostFn, channelId: string, ts: string | undefined, card: RenderedCard): Promise<void> {
  if (!ts) return;
  if (swallowRoomOp("a slack approval-card rewrite")) return;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("ts", ts);
  body.set("text", card.text);
  body.set("blocks", JSON.stringify(card.blocks));
  await post("chat.update", body.toString());
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

async function postRenderedCard(post: PostFn, channelId: string, threadTs: string | null | undefined, card: RenderedCard): Promise<string | undefined> {
  const body = new URLSearchParams();
  body.set("channel", channelId);
  if (threadTs) body.set("thread_ts", threadTs);
  body.set("text", card.text);
  body.set("blocks", JSON.stringify(card.blocks));
  const res = await post("chat.postMessage", body.toString());
  return res?.ok === true && typeof res.ts === "string" ? res.ts : undefined;
}

async function postThreadNote(post: PostFn, channelId: string, threadTs: string | undefined, text: string): Promise<void> {
  if (swallowRoomOp("a slack approval thread note")) return;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  if (threadTs) body.set("thread_ts", threadTs);
  body.set("text", text);
  await post("chat.postMessage", body.toString());
}

function decisionNoticeText(summaryLines: string[], outcomeLine: string, clickerId: string, status: PendingStatus): string {
  const what = summaryLines[0] ?? "the requested change";
  if (status === "rejected") {
    return outcomeLine === "rejected"
      ? `⛔ Approval REJECTED by <@${clickerId}> — "${what}" was NOT applied. Propose again if it's still needed.`
      : `⛔ Approval REJECTED by <@${clickerId}> — "${what}" was NOT applied. ${outcomeLine}.`;
  }
  if (status === "expired") return `⌛ Approval EXPIRED without a decision — "${what}" was NOT applied. Propose again if it's still needed.`;
  return `✅ Approval APPROVED by <@${clickerId}> — "${what}": ${outcomeLine}`;
}

function summaryLinesFor(row: PendingActionRow): string[] {
  const kindDef = actionKind(row.kind);
  if (!kindDef) return [`(no registered ActionKind for "${row.kind}")`];
  try {
    const args = JSON.parse(row.argsJson);
    return withTaintDisclosure(kindDef.summarize(args), args, { live: false });
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
  readonly clickerPlatform?: string;
  readonly clickerTenant?: string;
  readonly clickerIsGuest?: boolean;
}

async function auditClickerDenial(
  org: string,
  row: PendingActionRow,
  clickerId: string,
  reason: ClickerFloorRefusal | "not-admin",
  clickSurfaceKey?: string,
): Promise<void> {
  await appendAudit({
    ...whereFromScope(org, row.scopeKey),
    principalId: clickerId,
    action: "approval.denied",
    detail: { id: row.id, kind: row.kind, ...venueDetail(row, clickSurfaceKey), reason },
  }).catch(() => undefined);
}

export async function resolveApprovalClick(input: ResolveApprovalClickInput): Promise<ApprovalClickResolution> {
  const store = getOperationalStore();
  const row = await store.getPendingAction(input.org, input.id);

  if (!row) return { outcome: "unknown" };

  const contradicting = input.decision === "contradict";
  if (!contradicting && row.status !== "pending") return { outcome: "not-pending" };

  const nowIso = new Date().toISOString();
  if (!contradicting && Date.parse(row.expiresAt) <= Date.now()) {
    const cas = await store.decidePendingAction(input.org, row.id, "expired", "system", nowIso);
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
  if (kindDef.policy === "admin" && !clickerMayDecide(row, input.clickerId, clickerPlatform, clickerTenant) && (await input.platformAdmin?.(row)) !== true) {
    await auditClickerDenial(input.org, row, input.clickerId, "not-admin", input.clickContext?.surfaceKey);
    return { outcome: "denied", row };
  }

  const venue = venueDetail(row, input.clickContext?.surfaceKey);

  if (contradicting) {
    const res = await contradictJudgeAllow({ org: input.org, id: row.id, principalId: input.clickerId, route: "click", venue });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_judge_contradicted", "oe.outcome": res.outcome });
    return { outcome: "contradicted", row, summaryLines: summaryLinesFor(row), contradiction: res.outcome };
  }

  const status = input.decision === "reject" ? "rejected" : "approved";
  const cas = await store.decidePendingAction(input.org, row.id, status, input.clickerId, nowIso);
  if (!cas) return { outcome: "lost-race" };

  const decidedRow: PendingActionRow = { ...row, status, decidedBy: input.clickerId, decidedAt: nowIso };
  const summaryLines = summaryLinesFor(decidedRow);

  if (status === "rejected") {
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.rejected", detail: { id: row.id, kind: row.kind, ...venue } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "rejected" });
    let outcomeLine = "rejected";
    if (kindDef.declined) {
      outcomeLine = await kindDef
        .declined(JSON.parse(row.argsJson) as unknown, input.clickerId)
        .catch((err: unknown) => `rejected — ${err instanceof Error ? err.message : String(err)}`);
    }
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine, executed: "none" };
  }

  if (input.decision === "approve_session") {
    const memoKind = sessionGrantKind(row);
    const sessionId = sessionIdFromFrozenArgs(row.argsJson);
    if (memoKind && sessionId) {
      const expiresAt = new Date(Date.now() + sessionApprovalTtlHours() * 3_600_000).toISOString();
      await store.setSessionApproval({ org: input.org, sessionId, kind: memoKind, grantedBy: input.clickerId, createdAt: nowIso, expiresAt }).catch(() => {});
      await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.session_granted", detail: { id: row.id, kind: row.kind, memoKind, ...venue } }).catch(() => undefined);
    }
  }

  try {
    const args = JSON.parse(row.argsJson) as unknown;
    const outcome = await withArmingApproval({ id: row.id, kind: row.kind }, () => kindDef.execute(args, input.clickerId));
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.approved", detail: { id: row.id, kind: row.kind, ...venue, outcome } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "approved" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: outcome, executed: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.failed", detail: { id: row.id, kind: row.kind, ...venue, error: message } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "failed" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: `FAILED: ${message}`, executed: "failed" };
  }
}

export interface SweepFeedbackDeps {
  readonly post?: PostFn;
  readonly discordNotice?: (row: PendingActionRow, text: string) => Promise<unknown>;
  readonly decisionWake?: DecisionWakeDeps;
}

async function sweepExpiryFeedback(row: PendingActionRow, deps: SweepFeedbackDeps): Promise<void> {
  if (!row.postedTo) return;
  const [platform, workspace] = row.postedTo.split("/");
  if (!workspace) return;
  const post = deps.post ?? bridgeSlackForm;
  const postNotice =
    platform === "slack"
      ? (text: string) => postThreadNote(post, row.channelId, row.threadTs ?? row.messageTs ?? undefined, text)
      : platform === "discord"
        ? (text: string) => (deps.discordNotice ?? postDiscordDecisionNotice)(row, text)
        : null;
  if (!postNotice) return;
  await deliverDecisionFeedback(
    {
      row,
      summaryLines: summaryLinesFor(row),
      outcome: "expired",
      outcomeLine: "expired",
      executed: "none",
      target: platform === "slack" ? slackDecisionWakeTarget(row, workspace) : discordDecisionWakeTarget(row, workspace),
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
      const won = await store.decidePendingAction(org, row.id, "expired", "system", nowIso);
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

export interface DecisionWakeDeps {
  readonly dispatch?: typeof dispatchApprovalDecisionWake;
  readonly now?: () => string;
  readonly mintWakeId?: () => string;
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

  let domainName: string;
  let registryKey: string;
  try {
    const grain = supervisorGrainFor(input.surfaceKey, getConfig().loadDomains());
    if (!grainUsesUnifiedWindow(grain) || grain.domainName === undefined) return false;
    domainName = grain.domainName;
    registryKey = grain.registryKey;
  } catch {
    return false;
  }

  const store = getOperationalStore();
  const session = await store.getChannelSession(input.row.org, registryKey).catch(() => null);
  if (!session) return false;

  const wakeId = mint();
  const message = renderApprovalDecisionMessage(
    {
      origin: input.origin,
      wakeId,
      summaryLine: input.summaryLine,
      outcome: input.outcome,
      ...(input.clickerId ? { clickerId: input.clickerId } : {}),
      ...(input.execution ? { execution: input.execution } : {}),
      pendingId: input.row.id,
    },
    nowIso,
  );
  const delivered = await dispatch({ token: session.token, origin: input.origin, wakeId, message, domain: domainName }).catch(() => false);

  await appendAudit({
    ...whereFromScope(input.row.org, input.row.scopeKey),
    principalId: input.clickerId ?? "system",
    action: "approval.decision_wake",
    detail: { id: input.row.id, kind: input.row.kind, outcome: input.outcome, domain: domainName, delivered, wakeId },
  }).catch(() => undefined);
  return delivered;
}

function slackDecisionWakeTarget(row: PendingActionRow, teamId: string | undefined): { surfaceKey: string; origin: UnifiedWakeOrigin } | null {
  if (!teamId) return null;
  return {
    surfaceKey: `slack/${teamId}/${row.channelId}`,
    origin: { platform: "slack", channelId: row.channelId, ...(row.threadTs ? { threadTs: row.threadTs } : {}) },
  };
}

export function discordDecisionWakeTarget(row: PendingActionRow, guildId: string | undefined): { surfaceKey: string; origin: UnifiedWakeOrigin } | null {
  if (!guildId) return null;
  return {
    surfaceKey: `discord/${guildId}/${row.channelId}`,
    origin: { platform: "discord", channelId: row.channelId, guildId, ...(row.messageTs ? { messageId: row.messageTs } : {}) },
  };
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
  readonly postNotice: (text: string) => Promise<unknown>;
}

export async function deliverDecisionFeedback(input: DecisionFeedbackInput, decisionWake?: DecisionWakeDeps): Promise<void> {
  if (!swallowRoomOp(`an approval decision notice (${input.outcome})`)) {
    await input.postNotice(decisionNoticeText(input.summaryLines, input.outcomeLine, input.clickerId ?? "system", input.outcome)).catch(() => undefined);
  }
  if (input.target) {
    await wakeWindowOnDecision(
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
    ).catch(() => undefined);
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
      ...(teamId ? { clickContext: { surfaceKey: `slack/${teamId}/${channelId}` } } : {}),
      ...(clickerIsGuest === undefined ? {} : { clickerIsGuest }),
    });
    switch (res.outcome) {
      case "unknown":
        if (parsed.decision === "contradict") {
          await postThreadNote(post, channelId, messageTs, `<@${clickerId}> ${judgeContradictionNotice("unknown")}`);
          return true;
        }
        await updateCardText(post, channelId, messageTs, "This approval request is no longer known (it may have already been decided or has aged out).");
        return true;
      case "not-pending":
      case "expired-race":
      case "unregistered-kind":
      case "lost-race":
        return true;
      case "expired": {
        await updateCard(post, channelId, messageTs, decidedCardBlocks(res.row, res.summaryLines, "expired"));
        await deliverDecisionFeedback(
          {
            row: res.row,
            summaryLines: res.summaryLines,
            outcome: "expired",
            outcomeLine: "expired",
            executed: "none",
            target: slackDecisionWakeTarget(res.row, teamId),
            postNotice: (text) => postThreadNote(post, channelId, res.row.threadTs ?? messageTs, text),
          },
          deps.decisionWake,
        );
        return true;
      }
      case "denied":
        await postThreadNote(post, channelId, res.row.threadTs ?? messageTs, `<@${clickerId}> only a domain/org admin can decide this request.`);
        return true;
      case "clicker-denied":
        await postThreadNote(post, channelId, res.row.threadTs ?? messageTs, `<@${clickerId}> ${clickerFloorRefusalNotice(res.reason)}`);
        return true;
      case "contradicted": {
        await postThreadNote(post, channelId, res.row.threadTs ?? messageTs, `<@${clickerId}> ${judgeContradictionNotice(res.contradiction)}`);
        return true;
      }
      case "decided": {
        await updateCard(post, channelId, messageTs, decidedCardBlocks(res.row, res.summaryLines, res.outcomeLine));
        await deliverDecisionFeedback(
          {
            row: res.row,
            summaryLines: res.summaryLines,
            outcome: res.row.status as ApprovalOutcome,
            outcomeLine: res.outcomeLine,
            executed: res.executed,
            clickerId,
            target: slackDecisionWakeTarget(res.row, teamId),
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
