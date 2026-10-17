import { auditErrorDetail } from "../audit/tool-action.js";
import { defineState } from "eve/context";
import { getOperationalStore } from "../operational/provider.js";
import type { AttentionRow, AttentionStateName } from "../operational/store.js";
import { appendAudit } from "../audit/audit.js";
import { deliverProactiveDm, dmDeliveryFooter, personAddress, ProactiveDmRefusedError } from "../channels/dm-audience.js";
import { resolveMessagePermalink } from "../channels/surface-message-ops.js";
import { linkSafeLine } from "../approvals/plain-text.js";
import type { SurfaceBinding } from "../identity/binding.js";

const ATTENTION_SUMMARY_MAX = 200;

export const ATTENTION_PING_FAILED_ACTION = "attention.ping_failed";

export const ATTENTION_LABEL: Record<AttentionStateName, string> = {
  working: "working",
  needs_input: "needs you",
  blocked: "blocked on you",
  done: "done",
};

export interface AttentionWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly surfaceKey: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly personId?: string;
  readonly dm: boolean;
}

export function attentionWhereOf(binding: SurfaceBinding, surfaceKey: string): AttentionWhere {
  const target = binding.target?.["channelId"];
  return {
    org: binding.org,
    platform: binding.platform,
    workspace: binding.workspace,
    surface: binding.surface,
    surfaceKey,
    channelId: typeof target === "string" && target.length > 0 ? target : (binding.anchorChannelId ?? binding.surface),
    threadTs: binding.threadTs ?? binding.anchorMessageId ?? null,
    ...(binding.principalId ? { personId: binding.principalId } : {}),
    dm: binding.mode === "dm",
  };
}

function attentionNeedsPerson(state: AttentionStateName | null | undefined): boolean {
  return state === "needs_input" || state === "blocked";
}

const sessionAttentionSlot = defineState<AttentionStateName | null>("open-everywhere.attention.session-state", () => null);

export function noteSessionAttention(state: AttentionStateName): void {
  try {
    sessionAttentionSlot.update(() => state);
  } catch {
  }
}

export function resetSessionAttention(): void {
  try {
    sessionAttentionSlot.update(() => null);
  } catch {
  }
}

export function sessionNeedsPerson(): boolean {
  try {
    return attentionNeedsPerson(sessionAttentionSlot.get());
  } catch {
    return false;
  }
}

export interface AttentionDeps {
  readonly now?: () => Date;
  readonly deliver?: typeof deliverProactiveDm;
  readonly permalink?: typeof resolveMessagePermalink;
}

export interface AttentionOutcome {
  readonly recorded: AttentionRow | null;
  readonly pinged: boolean;
}

function clipAttentionSummary(summary: string): string {
  return linkSafeLine(summary, ATTENTION_SUMMARY_MAX);
}

async function workLink(where: Pick<AttentionWhere, "platform" | "workspace" | "channelId" | "threadTs">, permalink: typeof resolveMessagePermalink): Promise<string> {
  if (where.threadTs) {
    const url = await permalink(where.platform, { channelId: where.channelId, messageId: where.threadTs, workspace: where.workspace }).catch(() => undefined);
    if (url) return url;
  }
  return where.platform === "slack" || where.platform === "discord" ? `<#${where.channelId}>` : "the conversation where you started it";
}

export function blockedPingText(summary: string, link: string): string {
  return `⛔ A job you asked for is blocked and needs you: ${summary}\nIt is waiting here: ${link}`;
}

export async function recordAttention(where: AttentionWhere, sessionId: string, state: AttentionStateName, summary: string, deps: AttentionDeps = {}): Promise<AttentionOutcome> {
  if (where.dm) return { recorded: null, pinged: false };
  const store = getOperationalStore();
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let recorded: AttentionRow;
  try {
    recorded = await store.recordAttentionState({
      org: where.org,
      sessionId,
      state,
      summary: clipAttentionSummary(summary),
      surfaceKey: where.surfaceKey,
      channelId: where.channelId,
      threadTs: where.threadTs,
      personPlatform: where.personId ? where.platform : null,
      personId: where.personId ?? null,
      updatedAt: now,
    });
  } catch (err) {
    console.warn(`[open-everywhere:attention] the attention state was not recorded: ${String(err)}`);
    return { recorded: null, pinged: false };
  }
  if (recorded.state !== "blocked" || !where.personId) return { recorded, pinged: false };
  let claimed = false;
  try {
    claimed = await store.claimAttentionPing(where.org, sessionId, recorded.since);
  } catch (err) {
    console.warn(`[open-everywhere:attention] the blocked-ping claim failed; no ping sent: ${String(err)}`);
    return { recorded, pinged: false };
  }
  if (!claimed) return { recorded, pinged: false };
  const auditWhere = { org: where.org, platform: where.platform, workspace: where.workspace, ...(where.surface ? { surface: where.surface } : {}) };
  try {
    const link = await workLink(where, deps.permalink ?? resolveMessagePermalink);
    await (deps.deliver ?? deliverProactiveDm)({
      where: auditWhere,
      plane: "attention.blocked",
      platform: where.platform,
      recipientId: where.personId,
      address: personAddress(where.platform, where.personId),
      text: blockedPingText(recorded.summary, link),
      footer: dmDeliveryFooter({ platform: where.platform, recipientId: where.personId, requestedBy: where.personId }),
      requestedBy: where.personId,
      attributedTo: where.personId,
    });
    return { recorded, pinged: true };
  } catch (err) {
    if (!(err instanceof ProactiveDmRefusedError)) {
      await appendAudit({
        ...auditWhere,
        principalId: where.personId,
        action: ATTENTION_PING_FAILED_ACTION,
        detail: { sessionId, reason: auditErrorDetail(err).error },
      }).catch(() => undefined);
    }
    console.warn(`[open-everywhere:attention] the blocked ping did not land: ${String(err)}`);
    return { recorded, pinged: false };
  }
}
