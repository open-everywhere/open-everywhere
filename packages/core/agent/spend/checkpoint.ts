import type { BindableContext } from "../identity/binding.js";
import { bindFrom, currentWindowToken } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { domainKeyOf, resolvePartition, type Partition } from "../memory/partition.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { getOperationalStore } from "../operational/provider.js";
import { usageForSession } from "./usage-events.js";
import { resolveAssumedModel, rowCostUsd } from "./reporting.js";
import { getConfig } from "../access/config.js";
import { domainNameForScope } from "./caps.js";
import { auditToolAction } from "../audit/tool-action.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "../tools/set_spend_limit.js";
import "../approvals/session-checkpoint.js";
import { CHECKPOINT_KIND, CHECKPOINT_GRANT_MEMO, CHECKPOINT_ASK_MEMO, checkpointTtlHours } from "../approvals/session-checkpoint.js";

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

export function checkCheckpoint(usage: SessionUsage, cp: Checkpoint): CheckpointVerdict {
  if (cp.sessionTokens != null && usage.tokens >= cp.sessionTokens) {
    return { crossed: true, reason: `this session reached its cost checkpoint (${usage.tokens.toLocaleString()} / ${cp.sessionTokens.toLocaleString()} tokens)` };
  }
  if (cp.sessionModelCalls != null && usage.modelCalls >= cp.sessionModelCalls) {
    return { crossed: true, reason: `this session reached its cost checkpoint (${usage.modelCalls.toLocaleString()} / ${cp.sessionModelCalls.toLocaleString()} model calls)` };
  }
  if (cp.sessionUsd != null && (usage.usd ?? 0) >= cp.sessionUsd) {
    return { crossed: true, reason: `this session reached its cost checkpoint (~$${(usage.usd ?? 0).toFixed(2)} of $${cp.sessionUsd.toFixed(2)})` };
  }
  return { crossed: false };
}

export function checkpointConfigured(cp: Checkpoint): boolean {
  return CHECKPOINT_FIELDS.some((f) => cp[f] != null);
}

export async function sessionUsage(org: string, sessionId: string): Promise<SessionUsage> {
  const rows = await usageForSession(org, sessionId);
  const assumed = resolveAssumedModel();
  let tokens = 0;
  let modelCalls = 0;
  let usd: number | undefined;
  for (const r of rows) {
    if (r.kind === "sandbox") continue;
    modelCalls++;
    tokens += r.inputTokens + r.outputTokens;
    const cost = rowCostUsd(r, assumed);
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

type CheckpointPlan =
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
    };

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

  const store = getOperationalStore();
  const now = new Date().toISOString();
  const grant = await store.getSessionApproval(p.org, memoKey, CHECKPOINT_GRANT_MEMO, now).catch(() => null);
  if (grant) return { decision: "proceed" };

  const usage = await sessionUsage(p.org, eventKey);
  const verdict = checkCheckpoint(usage, cp);
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
    reason: verdict.reason ?? "this session reached its cost checkpoint",
  };
}

function checkpointCardLines(plan: Extract<CheckpointPlan, { decision: "block" }>): string[] {
  const cp = plan.checkpoint;
  const lines = ["Continue this session past its cost checkpoint?", `Scope: \`${plan.surfaceKey}\``];
  lines.push(`So far this session: ${plan.usage.tokens.toLocaleString()} tokens, ${plan.usage.modelCalls.toLocaleString()} model calls${plan.usage.usd !== undefined ? `, ~$${plan.usage.usd.toFixed(2)}` : ""}.`);
  const limits: string[] = [];
  if (cp.sessionTokens != null) limits.push(`${cp.sessionTokens.toLocaleString()} tokens`);
  if (cp.sessionModelCalls != null) limits.push(`${cp.sessionModelCalls.toLocaleString()} model calls`);
  if (cp.sessionUsd != null) limits.push(`$${cp.sessionUsd.toFixed(2)}`);
  if (limits.length) lines.push(`Checkpoint: ${limits.join(" / ")}.`);
  lines.push("Approve to let the agent resume consequential actions (PRs, memory writes, …) for the rest of this session. Decline to keep them paused — reads and replies are unaffected either way.");
  return lines;
}

function blockMessage(reason: string, toolName: string, carded: boolean): string {
  return (
    `Paused: ${reason}. Running \`${toolName}\` is a consequential action, so it's held until a member ` +
    `${carded ? "confirms on the card just posted" : "confirms continuing"} for this session. You can still ` +
    `read and reply in the meantime — do that, or tell the user you're waiting on a "keep going?" confirmation. ` +
    `Do NOT retry \`${toolName}\` until someone approves.`
  );
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

  const store = getOperationalStore();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + checkpointTtlHours() * 3_600_000).toISOString();

  const alreadyAsked = await store.getSessionApproval(plan.org, plan.memoKey, CHECKPOINT_ASK_MEMO, nowIso).catch(() => null);
  if (!alreadyAsked) {
    try {
      await requestApproval(
        {
          org: plan.org,
          kind: CHECKPOINT_KIND,
          args: { org: plan.org, scopeKey: plan.surfaceKey, sessionId: plan.memoKey },
          scopeKey: plan.surfaceKey,
          domain: plan.domain,
          requestedBy: requestedBy!,
          channelId: channelId!,
          threadTs: binding.threadTs ?? null,
          postedTo: postedToSurfaceKey(binding, channelId!),
          summaryLines: checkpointCardLines(plan),
        },
        approvalPostDeps(binding.platform),
      );
      await store.setSessionApproval({ org: plan.org, sessionId: plan.memoKey, kind: CHECKPOINT_ASK_MEMO, grantedBy: requestedBy!, createdAt: nowIso, expiresAt });
      await auditToolAction(ctx, "checkpoint.trip", { tool: toolName, carded: true, reason: plan.reason });
    } catch (err) {
      console.warn(`[open-everywhere:checkpoint] could not post checkpoint card for "${toolName}": ${String(err)}`);
      await auditToolAction(ctx, "checkpoint.trip", { tool: toolName, carded: false, reason: plan.reason, note: "card post failed" });
    }
  }
  throw new Error(blockMessage(plan.reason, toolName, !alreadyAsked));
}
