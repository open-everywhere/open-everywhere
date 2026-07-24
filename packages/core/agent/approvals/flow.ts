import { randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { onVercel } from "../access/platform.js";
import { criteriaDomain } from "../memory/domain.js";
import { slackForm } from "../channels/slack-events.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { grainUsesUnifiedWindow, supervisorGrainFor } from "../channels/unified-supervisor.js";
import { mintWakeId, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { dispatchApprovalDecisionWake } from "../channels/unified.js";
import { surfaceMessageOps } from "../channels/surface-message-ops.js";
import { renderApprovalDecisionMessage, type ApprovalOutcome } from "./decision-wake.js";
import { actionKind, whereFromScope } from "./actions.js";
import { pendingCardBlocks, decidedCardBlocks, type RenderedCard } from "./card.js";
import { markCardPostedThisTurn } from "./card-signal.js";
import type { PendingActionRow, PendingStatus } from "./types.js";
import "./memory-forget.js";
import "./access-request.js";
import "./skill-create.js";
import "./routine-create.js";
import "./memory-remember.js";
import "./memory-float.js";
import "./pr-open.js";
import "./skill-delete.js";
import "./routine-cancel.js";
import "./ticket-actions.js";
import "./session-checkpoint.js";

export const OE_APPROVAL_PREFIX = "oe_approval:";

type PostFn = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export type ApprovalDecision = "approve" | "reject" | "approve_session";

export function parseApprovalAction(actionId: string): { decision: ApprovalDecision; id: string } | null {
  if (!actionId.startsWith(OE_APPROVAL_PREFIX)) return null;
  const rest = actionId.slice(OE_APPROVAL_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const decision = rest.slice(0, sep);
  const id = rest.slice(sep + 1);
  if ((decision !== "approve" && decision !== "reject" && decision !== "approve_session") || id.length === 0) return null;
  return { decision, id };
}

function sessionApprovalTtlHours(): number {
  const raw = Number(process.env.OE_PR_SESSION_APPROVAL_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
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
  const raw = Number(process.env.OE_APPROVAL_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
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
}

export type CardPoster = (row: PendingActionRow, summaryLines: readonly string[]) => Promise<string | undefined>;

const CARD_POSTERS = new Map<string, CardPoster>();

export function registerCardPoster(platform: string, poster: CardPoster): void {
  CARD_POSTERS.set(platform, poster);
}

export function cardPosterFor(platform: string | undefined): CardPoster | undefined {
  return platform === undefined ? undefined : CARD_POSTERS.get(platform);
}

export interface RequestApprovalDeps {
  readonly post?: PostFn;
  readonly postCard?: CardPoster;
}

export async function requestApproval(input: RequestApprovalInput, deps: RequestApprovalDeps = {}): Promise<{ id: string; expiresAt: string; deduped?: boolean }> {
  const kindDef = actionKind(input.kind);
  if (!kindDef) {
    throw new Error(`requestApproval: no registered ActionKind for "${input.kind}"`);
  }

  const post = deps.post ?? slackForm;
  const store = getOperationalStore();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + approvalTtlHours() * 3_600_000).toISOString();
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

  const summaryLines = input.summaryLines ? [...input.summaryLines] : kindDef.summarize(input.args);

  let messageTs: string | undefined;
  if (deps.postCard) {
    messageTs = await deps.postCard(row, summaryLines);
  } else if (process.env.OE_EGRESS_SPOOF === "1") {
    if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed an approval-card post for "${input.kind}" (${input.scopeKey})`);
    messageTs = `spoof-card-${Date.now()}`;
  } else {
    const { blocks, text } = pendingCardBlocks(row, summaryLines);

    const body = new URLSearchParams();
    body.set("channel", input.channelId);
    if (input.threadTs) body.set("thread_ts", input.threadTs);
    body.set("text", text);
    body.set("blocks", JSON.stringify(blocks));

    const res = await post("chat.postMessage", body.toString());
    messageTs = res?.ok === true && typeof res.ts === "string" ? res.ts : undefined;
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

export function isDomainLevelSpendCap(row: PendingActionRow): boolean {
  if (row.kind !== "spend.set" && row.kind !== "spend.clear") return false;
  try {
    const args = JSON.parse(row.argsJson) as { level?: unknown };
    return args.level === "domain";
  } catch {
    return false;
  }
}

export function clickerMayDecide(row: PendingActionRow, clickerId: string): boolean {
  const domains = getConfig().loadDomains();
  if (criteriaDomain("org", domains)?.admins?.includes(clickerId) === true) return true;
  if (isDomainLevelSpendCap(row)) return false;
  if (!row.domain) return false;
  const explicit = domains.find((d) => d.name === row.domain);
  return explicit?.admins?.includes(clickerId) === true;
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
}

async function updateCard(post: PostFn, channelId: string, ts: string | undefined, card: RenderedCard): Promise<void> {
  if (!ts) return;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("ts", ts);
  body.set("text", card.text);
  body.set("blocks", JSON.stringify(card.blocks));
  await post("chat.update", body.toString());
}

async function updateCardText(post: PostFn, channelId: string, ts: string | undefined, text: string): Promise<void> {
  if (!ts) return;
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("ts", ts);
  body.set("text", text);
  body.set("blocks", JSON.stringify([{ type: "section", text: { type: "mrkdwn", text } }]));
  await post("chat.update", body.toString());
}

async function postThreadNote(post: PostFn, channelId: string, threadTs: string | undefined, text: string): Promise<void> {
  const body = new URLSearchParams();
  body.set("channel", channelId);
  if (threadTs) body.set("thread_ts", threadTs);
  body.set("text", text);
  await post("chat.postMessage", body.toString());
}

function decisionNoticeText(summaryLines: string[], outcomeLine: string, clickerId: string, status: PendingStatus): string {
  const what = summaryLines[0] ?? "the requested change";
  if (status === "rejected") return `⛔ Approval REJECTED by <@${clickerId}> — "${what}" was NOT applied. Propose again if it's still needed.`;
  if (status === "expired") return `⌛ Approval EXPIRED without a decision — "${what}" was NOT applied. Propose again if it's still needed.`;
  return `✅ Approval APPROVED by <@${clickerId}> — "${what}": ${outcomeLine}`;
}

function summaryLinesFor(row: PendingActionRow): string[] {
  const kindDef = actionKind(row.kind);
  if (!kindDef) return [`(no registered ActionKind for "${row.kind}")`];
  try {
    return kindDef.summarize(JSON.parse(row.argsJson));
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
  | { readonly outcome: "lost-race" }
  | { readonly outcome: "decided"; readonly row: PendingActionRow; readonly summaryLines: string[]; readonly outcomeLine: string };

export interface ResolveApprovalClickInput {
  readonly org: string;
  readonly id: string;
  readonly decision: ApprovalDecision;
  readonly clickerId: string;
  readonly platformAdmin?: (row: PendingActionRow) => boolean | Promise<boolean>;
}

export async function resolveApprovalClick(input: ResolveApprovalClickInput): Promise<ApprovalClickResolution> {
  const store = getOperationalStore();
  const row = await store.getPendingAction(input.org, input.id);

  if (!row) return { outcome: "unknown" };
  if (row.status !== "pending") return { outcome: "not-pending" };

  const nowIso = new Date().toISOString();
  if (Date.parse(row.expiresAt) <= Date.now()) {
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

  if (kindDef.policy === "admin" && !clickerMayDecide(row, input.clickerId) && (await input.platformAdmin?.(row)) !== true) {
    return { outcome: "denied", row };
  }

  const status = input.decision === "reject" ? "rejected" : "approved";
  const cas = await store.decidePendingAction(input.org, row.id, status, input.clickerId, nowIso);
  if (!cas) return { outcome: "lost-race" };

  const decidedRow: PendingActionRow = { ...row, status, decidedBy: input.clickerId, decidedAt: nowIso };
  const summaryLines = summaryLinesFor(decidedRow);

  if (status === "rejected") {
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.rejected", detail: { id: row.id, kind: row.kind } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "rejected" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: "rejected" };
  }

  if (input.decision === "approve_session" && row.kind === "pr.open") {
    const sessionId = sessionIdFromFrozenArgs(row.argsJson);
    if (sessionId) {
      const expiresAt = new Date(Date.now() + sessionApprovalTtlHours() * 3_600_000).toISOString();
      await store.setSessionApproval({ org: input.org, sessionId, kind: "pr.open", grantedBy: input.clickerId, createdAt: nowIso, expiresAt }).catch(() => {});
      await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.session_granted", detail: { id: row.id, kind: row.kind } }).catch(() => undefined);
    }
  }

  try {
    const args = JSON.parse(row.argsJson) as unknown;
    const outcome = await kindDef.execute(args, input.clickerId);
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.approved", detail: { id: row.id, kind: row.kind, outcome } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "approved" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.failed", detail: { id: row.id, kind: row.kind, error: message } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "failed" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: `FAILED: ${message}` };
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
  const post = deps.post ?? slackForm;
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
  readonly clickerId?: string;
  readonly target: { surfaceKey: string; origin: UnifiedWakeOrigin } | null;
  readonly postNotice: (text: string) => Promise<unknown>;
}

export async function deliverDecisionFeedback(input: DecisionFeedbackInput, decisionWake?: DecisionWakeDeps): Promise<void> {
  await input.postNotice(decisionNoticeText(input.summaryLines, input.outcomeLine, input.clickerId ?? "system", input.outcome)).catch(() => undefined);
  if (input.target) {
    await wakeWindowOnDecision(
      {
        row: input.row,
        outcome: input.outcome,
        summaryLine: input.summaryLines[0] ?? "the requested change",
        ...(input.clickerId ? { clickerId: input.clickerId } : {}),
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

  const post = deps.post ?? slackForm;

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

    const res = await resolveApprovalClick({ org, id: parsed.id, decision: parsed.decision, clickerId });
    switch (res.outcome) {
      case "unknown":
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
      case "decided": {
        await updateCard(post, channelId, messageTs, decidedCardBlocks(res.row, res.summaryLines, res.outcomeLine));
        await deliverDecisionFeedback(
          {
            row: res.row,
            summaryLines: res.summaryLines,
            outcome: res.row.status as ApprovalOutcome,
            outcomeLine: res.outcomeLine,
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
