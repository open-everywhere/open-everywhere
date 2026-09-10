import { appendAudit } from "../audit/audit.js";
import { postHostNotice, REPLY_DEDUPE_SKIPPED_ID, type ReplyTarget } from "../channels/reply-post.js";

export interface ConsentOrigin {
  readonly org: string;
  readonly surfaceKey: string;
  readonly target: ReplyTarget;
  readonly principalId: string;
  readonly sessionId?: string;
}

export interface ConsentResumeRecord {
  readonly detourId: string;
  readonly connector: string;
  readonly origin: ConsentOrigin;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
}

export type ConsentResumeVerdict = "offer" | "expired";

export function consentResumeVerdict(input: {
  readonly record: ConsentResumeRecord;
  readonly nowMs: number;
}): ConsentResumeVerdict {
  return input.nowMs > input.record.expiresAtMs ? "expired" : "offer";
}

export function consentResumeOfferLine(record: ConsentResumeRecord): string {
  return (
    `Your personal *${record.connector}* account is connected now — say the word and I'll pick up ` +
    `the request I paused.`
  );
}

export function consentExpiredLine(record: ConsentResumeRecord): string {
  return (
    `Your personal *${record.connector}* account is connected, but the request I paused is too old ` +
    `to pick up on its own — ask me again and I'll run it.`
  );
}

function consentWhere(origin: ConsentOrigin): { org: string; platform: string; workspace: string; surface: string } {
  const [platform = "unknown", workspace = "unknown", ...rest] = origin.surfaceKey.split("/");
  return { org: origin.org, platform, workspace, surface: rest.join("/") || "unknown" };
}

export interface ConsentResumeDeps {
  readonly post?: (target: ReplyTarget, text: string) => Promise<string>;
  readonly nowMs?: () => number;
}

export interface ConsentResumeOutcome {
  readonly verdict: ConsentResumeVerdict;
  readonly delivered: boolean;
}

export async function resumeAfterConsent(
  record: ConsentResumeRecord,
  deps: ConsentResumeDeps = {},
): Promise<ConsentResumeOutcome> {
  const nowMs = (deps.nowMs ?? Date.now)();
  const verdict = consentResumeVerdict({ record, nowMs });

  let delivered = false;
  try {
    const post = deps.post ?? postHostNotice;
    const line = verdict === "expired" ? consentExpiredLine(record) : consentResumeOfferLine(record);
    delivered = (await post(record.origin.target, line)) !== REPLY_DEDUPE_SKIPPED_ID;
  } catch {
    delivered = false;
  }

  await appendAudit({
    ...consentWhere(record.origin),
    principalId: record.origin.principalId,
    action: "connector.consent_resume",
    detail: {
      detourId: record.detourId,
      connector: record.connector,
      verdict,
      delivered,
      ...(record.origin.sessionId ? { pausedSession: record.origin.sessionId } : {}),
    },
  }).catch(() => undefined);

  return { verdict, delivered };
}

export async function recordConsentDetour(input: {
  readonly connector: string;
  readonly origin: ConsentOrigin;
  readonly nowMs: number;
  readonly ttlMs: number;
  readonly detourId: string;
}): Promise<ConsentResumeRecord> {
  const record: ConsentResumeRecord = {
    detourId: input.detourId,
    connector: input.connector,
    origin: input.origin,
    startedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + input.ttlMs,
  };
  await appendAudit({
    ...consentWhere(input.origin),
    principalId: input.origin.principalId,
    action: "connector.consent_detour",
    detail: {
      detourId: record.detourId,
      connector: record.connector,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      ...(input.origin.sessionId ? { pausedSession: input.origin.sessionId } : {}),
    },
  }).catch(() => undefined);
  return record;
}

function addressableTarget(t: unknown): t is ReplyTarget {
  if (typeof t !== "object" || t === null) return false;
  const s = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  const r = t as Record<string, unknown>;
  switch (r.platform) {
    case "slack":
    case "discord":
      return s(r.channelId);
    case "notion":
      return s(r.discussionId);
    case "teams":
      return s(r.serviceUrl) && s(r.conversationId);
    case "github":
      return s(r.owner) && s(r.repo) && typeof r.issueNumber === "number";
    case "linear":
      return s(r.agentSessionId) || s(r.issueId);
    default:
      return false;
  }
}

export function asConsentResumeRecord(value: unknown): ConsentResumeRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Partial<ConsentResumeRecord>;
  if (typeof r.detourId !== "string" || r.detourId.length === 0) return undefined;
  if (typeof r.connector !== "string" || r.connector.length === 0) return undefined;
  if (typeof r.startedAtMs !== "number" || !Number.isFinite(r.startedAtMs)) return undefined;
  if (typeof r.expiresAtMs !== "number" || !Number.isFinite(r.expiresAtMs)) return undefined;
  const o = r.origin as Partial<ConsentOrigin> | undefined;
  if (!o || typeof o !== "object") return undefined;
  if (typeof o.org !== "string" || o.org.length === 0) return undefined;
  if (typeof o.surfaceKey !== "string" || o.surfaceKey.length === 0) return undefined;
  if (typeof o.principalId !== "string" || o.principalId.length === 0) return undefined;
  if (!addressableTarget(o.target)) return undefined;
  return r as ConsentResumeRecord;
}
