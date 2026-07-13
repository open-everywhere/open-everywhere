import { appendAudit, type AuditInput } from "../audit/audit.js";
import { renderWake, mkMessageTrigger, type NormalizedWake } from "./normalized-wake.js";
import {
  resolveUnifiedWakeTarget,
  WAKE_TARGET_TTL_MS,
  type UnifiedWakeOrigin,
  type UnifiedWakeTargetStore,
} from "./unified-window.js";

export const REDRIVE_ACTION = "unified.turn.redrive";

export const REDRIVE_GUARD_PREFIX = "unified-redrive:";

export const REDRIVE_GUARD_TTL_MS = WAKE_TARGET_TTL_MS;

export function redriveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OE_UNIFIED_REDRIVE ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export function redriveGuardKey(wakeId: string): string {
  return `${REDRIVE_GUARD_PREFIX}${wakeId}`;
}

export function describeRedriveTarget(origin: UnifiedWakeOrigin): string {
  switch (origin.platform) {
    case "slack":
      return `slack ${origin.threadTs ? `thread in ${origin.channelId}` : `channel ${origin.channelId}`}`;
    case "github":
      return `github ${origin.owner}/${origin.repo}#${origin.issueNumber}`;
    case "linear":
      return origin.ambient ? `linear issue ${origin.issueId}` : `linear session on issue ${origin.issueId}`;
    case "notion":
      return `notion discussion ${origin.discussionId}`;
    case "discord":
      return `discord channel ${origin.channelId}`;
    case "teams":
      return `teams conversation ${origin.conversationId}`;
  }
}

function originContainerId(origin: UnifiedWakeOrigin): string {
  switch (origin.platform) {
    case "slack":
      return origin.channelId;
    case "github":
      return `${origin.owner}/${origin.repo}`;
    case "linear":
      return origin.issueId;
    case "notion":
      return origin.discussionId;
    case "discord":
      return origin.channelId;
    case "teams":
      return origin.conversationId;
  }
}

export function redriveCorrectiveText(chars: number, originalWakeId: string, origin: UnifiedWakeOrigin): string {
  return (
    `Your previous turn's final prose (${chars} chars) was DISCARDED by the message-tool-only gate — ` +
    `it reached no one. If it should reach someone, call the \`reply\` tool NOW with \`wake\` set to ` +
    `"${originalWakeId}" (target: ${describeRedriveTarget(origin)}) and \`text\` set to your message. ` +
    `If it should NOT reach anyone after all, call \`no_reply\` (or end with NO_REPLY) — staying silent ` +
    `is still a valid outcome. This is a one-time correction: there is no second retry.`
  );
}

export function buildRedriveWake(originalWakeId: string, origin: UnifiedWakeOrigin, chars: number, nowIso: string): NormalizedWake {
  return {
    platform: origin.platform,
    reason: "channel-activity",
    addressing: "channel-watch",
    wakeId: originalWakeId,
    locus: { channel: { id: originContainerId(origin), platform: origin.platform } },
    trigger: mkMessageTrigger({
      from: "system",
      author: "open-everywhere",
      id: `redrive-${originalWakeId}`,
      sentAt: nowIso,
      trust: "relay",
      body: redriveCorrectiveText(chars, originalWakeId, origin),
    }),
  };
}

export type RedriveReinject = ((origin: UnifiedWakeOrigin, message: string, originalWakeId: string) => Promise<void>) | null;

export interface RedriveStore extends UnifiedWakeTargetStore {
  markEventSeen(org: string, key: string, at: string, ttlMs: number): Promise<boolean>;
}

export interface RedriveInput {
  readonly org: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly sessionId?: string;
  readonly wakeId: string | undefined;
  readonly chars: number;
  readonly replied: boolean;
}

export interface RedriveDeps {
  readonly store: RedriveStore;
  readonly reinject: RedriveReinject;
  readonly now?: () => string;
  readonly audit?: (entry: AuditInput) => Promise<void>;
}

export type RedriveStatus =
  | "disabled"
  | "skip-replied"
  | "skip-no-wake"
  | "skip-unresolved"
  | "skip-loop-guard"
  | "skip-no-reinject"
  | "reinject-failed"
  | "redriven";

export interface RedriveResult {
  readonly status: RedriveStatus;
  readonly originalWakeId?: string;
}

export async function maybeRedrive(input: RedriveInput, deps: RedriveDeps): Promise<RedriveResult> {
  if (!redriveEnabled()) return { status: "disabled" };
  if (input.replied) return { status: "skip-replied" };
  if (!input.wakeId) return { status: "skip-no-wake" };
  const wakeId = input.wakeId;
  const now = deps.now ?? (() => new Date().toISOString());
  const audit = deps.audit ?? appendAudit;

  const origin = await resolveUnifiedWakeTarget(deps.store, input.org, wakeId).catch(() => null);
  if (!origin) return { status: "skip-unresolved", originalWakeId: wakeId };

  if (!deps.reinject) return { status: "skip-no-reinject", originalWakeId: wakeId };

  let firstDrop: boolean;
  try {
    firstDrop = await deps.store.markEventSeen(input.org, redriveGuardKey(wakeId), now(), REDRIVE_GUARD_TTL_MS);
  } catch {
    return { status: "skip-loop-guard", originalWakeId: wakeId };
  }
  if (!firstDrop) return { status: "skip-loop-guard", originalWakeId: wakeId };

  const rendered = renderWake(buildRedriveWake(wakeId, origin, input.chars, now()));
  try {
    await deps.reinject(origin, rendered.message, wakeId);
  } catch {
    return { status: "reinject-failed", originalWakeId: wakeId };
  }

  await audit({
    org: input.org,
    platform: "unified",
    workspace: input.workspace,
    ...(input.surface ? { surface: input.surface } : {}),
    action: REDRIVE_ACTION,
    detail: {
      originalWakeId: wakeId,
      chars: input.chars,
      platform: origin.platform,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
  }).catch(() => undefined);

  return { status: "redriven", originalWakeId: wakeId };
}
