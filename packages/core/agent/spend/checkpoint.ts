import { placeWords } from "../channels/friendly-ids.js";
import type { BindableContext } from "../identity/binding.js";
import { bindFrom, currentWindowToken } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { domainKeyOf, resolvePartition, type Partition } from "../memory/partition.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { getOperationalStore } from "../operational/provider.js";
import { isRuntimeUsageKind, usageForSession } from "./usage-events.js";
import { resolveAssumedModel, rowCostUsd } from "./reporting.js";
import { getConfig } from "../access/config.js";
import { domainNameForScope } from "./caps.js";
import { auditToolAction } from "../audit/tool-action.js";
import { requestApproval, postedToSurfaceKey, cardPostFailureReason } from "../approvals/flow.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";
import { approvalPostDeps, hasApprovalCardPath } from "../tools/set_spend_limit.js";
import { routineMarker } from "../routines/routine.js";
import { recordCheckpointStall } from "../routines/outcome-fold.js";
import "../approvals/session-checkpoint.js";
import { CHECKPOINT_KIND, CHECKPOINT_GRANT_MEMO, CHECKPOINT_ASK_MEMO, DURABLE_GRANT_DISCLOSURE, checkpointTtlHours, liveGrantDisclosure } from "../approvals/session-checkpoint.js";
import { ROUTINE_PERMISSION_NO_EXPIRY } from "../routines/declared-permissions.js";

export interface Checkpoint {
  readonly sessionTokens?: number;
  readonly sessionModelCalls?: number;
  readonly sessionUsd?: number;
}

export interface SpendCheckpoints {
  readonly default?: Checkpoint;
  readonly perWorkspace?: Readonly<Record<string, Checkpoint>>;
  readonly perDomain?: Readonly<Record<string, Checkpoint>>;
  readonly perSurface?: Readonly<Record<string, Checkpoint>>;
}

export function defineSpendCheckpoints(checkpoints: SpendCheckpoints): SpendCheckpoints {
  return checkpoints;
}

const CHECKPOINT_FIELDS = ["sessionTokens", "sessionModelCalls", "sessionUsd"] as const;

function assertCheckpointShape(cp: Checkpoint, where: string): void {
  for (const key of Object.keys(cp)) {
    if (!(CHECKPOINT_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`spend checkpoint ${where} has unknown field "${key}" (valid: ${CHECKPOINT_FIELDS.join(", ")})`);
    }
  }
  if (CHECKPOINT_FIELDS.every((f) => cp[f] == null)) {
    throw new Error(`spend checkpoint ${where} sets no threshold at all — remove the entry or set at least one of ${CHECKPOINT_FIELDS.join(", ")}`);
  }
  for (const f of CHECKPOINT_FIELDS) {
    const v = cp[f];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`spend checkpoint ${where}.${f} must be a finite number > 0, got ${JSON.stringify(v)}`);
    }
    if ((f === "sessionTokens" || f === "sessionModelCalls") && !Number.isInteger(v)) {
      throw new Error(`spend checkpoint ${where}.${f} must be an integer count, got ${v}`);
    }
  }
}

export function assertSpendCheckpointsValid(checkpoints: SpendCheckpoints): void {
  if (checkpoints.default) assertCheckpointShape(checkpoints.default, "default");
  for (const [key, cp] of Object.entries(checkpoints.perWorkspace ?? {})) {
    const parts = key.split("/");
    if (parts.length !== 2 || parts.some((p) => !p)) {
      throw new Error(`spend checkpoint perWorkspace key must be "platform/workspace", got ${JSON.stringify(key)}`);
    }
    assertCheckpointShape(cp, `perWorkspace["${key}"]`);
  }
  for (const [key, cp] of Object.entries(checkpoints.perDomain ?? {})) {
    if (!key.trim()) {
      throw new Error(`spend checkpoint perDomain key must be a non-empty domain name, got ${JSON.stringify(key)}`);
    }
    assertCheckpointShape(cp, `perDomain["${key}"]`);
  }
  for (const [key, cp] of Object.entries(checkpoints.perSurface ?? {})) {
    const parts = key.split("/");
    if (parts.length !== 3 || parts.some((p) => !p)) {
      throw new Error(`spend checkpoint perSurface key must be "platform/workspace/surface", got ${JSON.stringify(key)}`);
    }
    assertCheckpointShape(cp, `perSurface["${key}"]`);
  }
}

function loadCheckpoints(): SpendCheckpoints {
  try {
    return getConfig().loadSpendCheckpoints?.() ?? {};
  } catch {
    return {};
  }
}

export function resolveCheckpoint(workspaceKey: string, surfaceKey: string, domainName?: string): Checkpoint {
  const cfg = loadCheckpoints();
  return (
    cfg.perSurface?.[surfaceKey] ??
    (domainName !== undefined ? cfg.perDomain?.[domainName] : undefined) ??
    cfg.perWorkspace?.[workspaceKey] ??
    cfg.default ??
    {}
  );
}

export interface SessionUsage {
  readonly tokens: number;
  readonly modelCalls: number;
  readonly usd?: number;
}

export interface CheckpointVerdict {
  readonly crossed: boolean;
  readonly reason?: string;
}

const WHOLE_SESSION_SUBJECT = "this session reached its cost checkpoint";
const SINCE_APPROVAL_SUBJECT = "this session spent another checkpoint's worth since a member approved it";

export function checkCheckpoint(usage: SessionUsage, cp: Checkpoint, subject: string = WHOLE_SESSION_SUBJECT): CheckpointVerdict {
  if (cp.sessionTokens != null && usage.tokens >= cp.sessionTokens) {
    return { crossed: true, reason: `${subject} (${usage.tokens.toLocaleString()} / ${cp.sessionTokens.toLocaleString()} tokens)` };
  }
  if (cp.sessionModelCalls != null && usage.modelCalls >= cp.sessionModelCalls) {
    return { crossed: true, reason: `${subject} (${usage.modelCalls.toLocaleString()} / ${cp.sessionModelCalls.toLocaleString()} model calls)` };
  }
  if (cp.sessionUsd != null && (usage.usd ?? 0) >= cp.sessionUsd) {
    return { crossed: true, reason: `${subject} (~$${(usage.usd ?? 0).toFixed(2)} of $${cp.sessionUsd.toFixed(2)})` };
  }
  return { crossed: false };
}

export function checkpointConfigured(cp: Checkpoint): boolean {
  return CHECKPOINT_FIELDS.some((f) => cp[f] != null);
}

export async function sessionUsage(org: string, sessionId: string, sinceIso?: string): Promise<SessionUsage> {
  const rows = await usageForSession(org, sessionId);
  const assumed = resolveAssumedModel();
  const sinceMs = sinceIso !== undefined ? Date.parse(sinceIso) : Number.NaN;
  const bounded = Number.isFinite(sinceMs);
  let tokens = 0;
  let modelCalls = 0;
  let usd: number | undefined;
  for (const r of rows) {
    if (bounded) {
      const at = Date.parse(r.ts);
      if (Number.isFinite(at) && at <= sinceMs) continue;
    }
    if (isRuntimeUsageKind(r.kind)) continue;
    modelCalls++;
    tokens += r.inputTokens + r.outputTokens;
    const cost = rowCostUsd(r, assumed, "one-call");
    if (cost !== undefined) usd = (usd ?? 0) + cost;
  }
  return { tokens, modelCalls, ...(usd !== undefined ? { usd } : {}) };
}

function sessionEventKey(ctx: BindableContext): string | undefined {
  const id = (ctx as { session?: { id?: unknown } }).session?.id;
  return id != null ? String(id) : undefined;
}

function windowMemoKey(ctx: BindableContext): string | undefined {
  const raw = (ctx as { channel?: { continuationToken?: unknown } }).channel?.continuationToken;
  return bareTokenFromEveContext(raw) ?? currentWindowToken(ctx) ?? sessionEventKey(ctx);
}

export type CheckpointPlan =
  | { readonly decision: "proceed" }
  | {
      readonly decision: "block";
      readonly org: string;
      readonly surfaceKey: string;
      readonly workspaceKey: string;
      readonly domain: string | null;
      readonly memoKey: string;
      readonly usage: SessionUsage;
      readonly checkpoint: Checkpoint;
      readonly reason: string;
      readonly durable: boolean;
      readonly approvedAt?: string;
    };

function routineIdOf(ctx: BindableContext): string | undefined {
  const fireAuth = ctx.session?.auth;
  return routineMarker(fireAuth?.current?.attributes ?? fireAuth?.initiator?.attributes)?.id;
}

async function evaluateCheckpoint(ctx: BindableContext): Promise<CheckpointPlan> {
  const p: Partition = resolvePartition(ctx);
  const scopeKey = domainKeyOf(p);
  const binding = bindFrom(ctx);
  const domainName = domainNameForScope(scopeKey, binding.mode, binding.trust);
  const cp = resolveCheckpoint(p.workspaceKey, scopeKey, domainName);
  if (!checkpointConfigured(cp)) return { decision: "proceed" };

  const memoKey = windowMemoKey(ctx);
  const eventKey = sessionEventKey(ctx);
  if (!memoKey || !eventKey) return { decision: "proceed" };

  const routineId = routineIdOf(ctx);
  const store = getOperationalStore();
  const now = new Date().toISOString();
  const grant = await store.getSessionApproval(p.org, memoKey, CHECKPOINT_GRANT_MEMO, now).catch(() => null);

  const durableGrant = grant?.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY;
  if (grant && !durableGrant) return { decision: "proceed" };

  const since = grant?.createdAt;
  const usage = await sessionUsage(p.org, eventKey, since);
  const verdict = checkCheckpoint(usage, cp, since !== undefined ? SINCE_APPROVAL_SUBJECT : WHOLE_SESSION_SUBJECT);
  if (!verdict.crossed) return { decision: "proceed" };

  return {
    decision: "block",
    org: p.org,
    surfaceKey: p.surfaceKey,
    workspaceKey: p.workspaceKey,
    domain: domainName ?? null,
    memoKey,
    usage,
    checkpoint: cp,
    reason: verdict.reason ?? WHOLE_SESSION_SUBJECT,
    durable: routineId !== undefined || durableGrant,
    ...(since !== undefined ? { approvedAt: since } : {}),
  };
}

export function checkpointCardLines(plan: Extract<CheckpointPlan, { decision: "block" }>, scopeLabel?: string): string[] {
  const cp = plan.checkpoint;
  const rebased = plan.approvedAt !== undefined;
  const spent = `${plan.usage.tokens.toLocaleString()} tokens, ${plan.usage.modelCalls.toLocaleString()} model calls${plan.usage.usd !== undefined ? `, about $${plan.usage.usd.toFixed(2)}` : ""}`;
  const lines = [
    rebased ? "Keep this session going past its cost checkpoint again?" : "Keep this session going past its cost checkpoint?",
    `In ${scopeLabel ?? placeWords({ key: plan.surfaceKey })}.`,
    rebased ? `Since a member approved this, it has used ${spent}.` : `So far this session: ${spent}.`,
  ];
  const limits: string[] = [];
  if (cp.sessionTokens != null) limits.push(`${cp.sessionTokens.toLocaleString()} tokens`);
  if (cp.sessionModelCalls != null) limits.push(`${cp.sessionModelCalls.toLocaleString()} model calls`);
  if (cp.sessionUsd != null) limits.push(`$${cp.sessionUsd.toFixed(2)}`);
  if (limits.length) lines.push(rebased ? `The checkpoint is another ${limits.join(" or ")}.` : `The checkpoint is ${limits.join(" or ")}.`);
  lines.push("Approve to let the agent do consequential work again — pull requests, memory writes and the like. Decline to keep that paused. Reading and replying carry on either way.");
  lines.push(plan.durable ? DURABLE_GRANT_DISCLOSURE : liveGrantDisclosure());
  return lines;
}

export type CheckpointCardState =
  | "posted"
  | "post-failed"
  | "already-asked";

export function checkpointCardFailureClass(err: unknown): string {
  const text = (cardPostFailureReason(err) ?? (err instanceof Error ? err.message : String(err))).toLowerCase();
  if (/no bot token is configured/.test(text)) return "no credential is configured, or the surface could not be reached";
  if (/rate.?limit|ratelimited|too many requests|slow down/.test(text)) return "rate limited";
  if (/invalid_auth|not_authed|token_revoked|token_expired|account_inactive|unauthorized|forbidden/.test(text)) return "the credential was refused";
  if (/channel_not_found|is_archived|not_in_channel|channel_is_archived|no surface message transport/.test(text)) return "the room is unreachable";
  if (/named no message id/.test(text)) return "the surface accepted the post but named no card";
  return "the surface reported no reason this deployment recognises";
}

export function checkpointBlockMessage(reason: string, toolName: string, card: CheckpointCardState, failureClass?: string): string {
  const head = `Paused: ${reason}. Running \`${toolName}\` is a consequential action, so it's held until a member `;
  const tail = `You can still read and reply in the meantime — do that, or tell the user you're waiting on a "keep going?" confirmation. Do NOT retry \`${toolName}\` until someone approves.`;
  if (card === "post-failed") {
    return (
      `${head}confirms continuing for this session. The confirmation card could NOT be posted to this room ` +
      `(${failureClass ?? "reason not reported by the surface"}), so nobody has been shown one — tell the user that, and ask them to ` +
      `confirm directly instead of looking for a card. The card is posted again on the next consequential attempt. ${tail}`
    );
  }
  return `${head}${card === "posted" ? "confirms on the card just posted" : "confirms continuing"} for this session. ${tail}`;
}

export async function requireSessionContinuation(ctx: BindableContext, toolName: string): Promise<void> {
  let plan: CheckpointPlan;
  try {
    plan = await evaluateCheckpoint(ctx);
  } catch (err) {
    console.warn(`[open-everywhere:checkpoint] evaluate skipped for "${toolName}": ${String(err)}`);
    return;
  }
  if (plan.decision === "proceed") return;

  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  const requestedBy = principalIdOf(ctx);
  const canAsk = hasApprovalCardPath(binding.platform) && !!channelId && !!requestedBy;

  if (!canAsk) {
    await auditToolAction(ctx, "checkpoint.trip", { tool: toolName, carded: false, allowed: true, reason: plan.reason, note: "no approval-card path — allowed" });
    return;
  }

  const fireAuth = ctx.session?.auth;
  const marker = routineMarker(fireAuth?.current?.attributes ?? fireAuth?.initiator?.attributes);
  if (marker) await recordCheckpointStall({ marker, tool: toolName, reason: plan.reason });

  const store = getOperationalStore();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + checkpointTtlHours() * 3_600_000).toISOString();

  const askRow = await store.getSessionApproval(plan.org, plan.memoKey, CHECKPOINT_ASK_MEMO, nowIso).catch(() => null);
  const askedAfterApproval = askRow !== null && (plan.approvedAt === undefined || Date.parse(askRow.createdAt) > Date.parse(plan.approvedAt));
  const alreadyAsked = askedAfterApproval ? askRow : null;
  const scopeLabel = alreadyAsked ? undefined : await friendlyScopeLabel(plan.surfaceKey);
  let cardState: CheckpointCardState = alreadyAsked ? "already-asked" : "post-failed";
  let failureClass: string | undefined;
  if (!alreadyAsked) {
    try {
      await requestApproval(
        {
          org: plan.org,
          kind: CHECKPOINT_KIND,
          args: { org: plan.org, scopeKey: plan.surfaceKey, sessionId: plan.memoKey, ...(plan.durable ? { durableSession: true as const } : {}), ...(scopeLabel ? { scopeLabel } : {}) },
          scopeKey: plan.surfaceKey,
          domain: plan.domain,
          requestedBy: requestedBy!,
          channelId: channelId!,
          threadTs: binding.threadTs ?? null,
          postedTo: postedToSurfaceKey(binding, channelId!),
          summaryLines: checkpointCardLines(plan, scopeLabel),
        },
        approvalPostDeps(binding.platform, ctx),
      );
      cardState = "posted";
      await store.setSessionApproval({ org: plan.org, sessionId: plan.memoKey, kind: CHECKPOINT_ASK_MEMO, grantedBy: requestedBy!, createdAt: nowIso, expiresAt });
      await auditToolAction(ctx, "checkpoint.trip", { tool: toolName, carded: true, reason: plan.reason });
    } catch (err) {
      if (cardState === "posted") {
        console.warn(`[open-everywhere:checkpoint] posted the checkpoint card for "${toolName}" but did not record the ask marker: ${String(err)}`);
        await auditToolAction(ctx, "checkpoint.trip", { tool: toolName, carded: true, reason: plan.reason, note: "ask marker not recorded" });
      } else {
        failureClass = checkpointCardFailureClass(err);
        console.warn(`[open-everywhere:checkpoint] could not post checkpoint card for "${toolName}": ${String(err)}`);
        await auditToolAction(ctx, "checkpoint.trip", { tool: toolName, carded: false, reason: plan.reason, note: "card post failed", reasonClass: failureClass });
      }
    }
  }
  throw new Error(checkpointBlockMessage(plan.reason, toolName, cardState, failureClass));
}
