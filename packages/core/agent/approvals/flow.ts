import { randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { criteriaDomain } from "../memory/domain.js";
import { slackForm } from "../channels/slack-events.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { actionKind, whereFromScope } from "./actions.js";
import { pendingCardBlocks, decidedCardBlocks, type RenderedCard } from "./card.js";
import { markCardPostedThisTurn } from "./card-signal.js";
import type { PendingActionRow } from "./types.js";
import "./memory-forget.js";
import "./access-request.js";

export const OE_APPROVAL_PREFIX = "oe_approval:";

type PostFn = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export function parseApprovalAction(actionId: string): { decision: "approve" | "reject"; id: string } | null {
  if (!actionId.startsWith(OE_APPROVAL_PREFIX)) return null;
  const rest = actionId.slice(OE_APPROVAL_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const decision = rest.slice(0, sep);
  const id = rest.slice(sep + 1);
  if ((decision !== "approve" && decision !== "reject") || id.length === 0) return null;
  return { decision, id };
}

function approvalTtlHours(): number {
  const raw = Number(process.env.OE_APPROVAL_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
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
}

export type CardPoster = (row: PendingActionRow, summaryLines: readonly string[]) => Promise<string | undefined>;

export interface RequestApprovalDeps {
  readonly post?: PostFn;
  readonly postCard?: CardPoster;
}

export async function requestApproval(input: RequestApprovalInput, deps: RequestApprovalDeps = {}): Promise<{ id: string; expiresAt: string }> {
  const kindDef = actionKind(input.kind);
  if (!kindDef) {
    throw new Error(`requestApproval: no registered ActionKind for "${input.kind}"`);
  }

  const post = deps.post ?? slackForm;
  const store = getOperationalStore();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + approvalTtlHours() * 3_600_000).toISOString();
  const argsJson = JSON.stringify(input.args ?? null);

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
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt,
    decidedBy: null,
    decidedAt: null,
  };

  await store.addPendingAction(row);

  const summaryLines = kindDef.summarize(input.args);

  let messageTs: string | undefined;
  if (deps.postCard) {
    messageTs = await deps.postCard(row, summaryLines);
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

function isDomainLevelSpendCap(row: PendingActionRow): boolean {
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
}

export interface HandleApprovalDeps {
  readonly post?: PostFn;
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
  readonly decision: "approve" | "reject";
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

  const status = input.decision === "approve" ? "approved" : "rejected";
  const cas = await store.decidePendingAction(input.org, row.id, status, input.clickerId, nowIso);
  if (!cas) return { outcome: "lost-race" };

  const decidedRow: PendingActionRow = { ...row, status, decidedBy: input.clickerId, decidedAt: nowIso };
  const summaryLines = summaryLinesFor(decidedRow);

  if (status === "rejected") {
    await appendAudit({ ...whereFromScope(input.org, row.scopeKey), principalId: input.clickerId, action: "approval.rejected", detail: { id: row.id, kind: row.kind } });
    emitTelemetry("oe.feature.used", { "oe.feature": "approval_decided", "oe.outcome": "rejected" });
    return { outcome: "decided", row: decidedRow, summaryLines, outcomeLine: "rejected" };
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
      case "expired":
        await updateCard(post, channelId, messageTs, decidedCardBlocks(res.row, res.summaryLines, "expired"));
        return true;
      case "denied":
        await postThreadNote(post, channelId, res.row.threadTs ?? messageTs, `<@${clickerId}> only a domain/org admin can decide this request.`);
        return true;
      case "decided":
        await updateCard(post, channelId, messageTs, decidedCardBlocks(res.row, res.summaryLines, res.outcomeLine));
        return true;
    }
  } catch (err) {
    console.error(`[open-everywhere:approvals] handleApprovalPayload failed softly for "${actionId}": ${String(err)}`);
    return true;
  }
}
