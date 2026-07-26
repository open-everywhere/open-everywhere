import { appendAudit, type AuditInput } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import type { WebhookHook } from "./config.js";
import type { WebhookRejection } from "./gate.js";
import { webhookOrg } from "./dispatch.js";

export const REJECTION_WINDOW_MS = 60_000;

export const REJECTION_ID_MAX_CHARS = 100;

export function rejectionThrottleKey(hook: WebhookHook | undefined, status: number): string {
  return hook ? `hookrej:${hook.id}:${status}` : `hookrej:unknown:${status}`;
}

const suppressed = new Map<string, number>();

export function resetRejectionThrottle(): void {
  suppressed.clear();
}

export interface RejectionAuditDeps {
  readonly markSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly now?: () => Date;
  readonly org?: string;
}

export async function auditWebhookRejection(
  id: string,
  hook: WebhookHook | undefined,
  rejection: WebhookRejection,
  deps: RejectionAuditDeps = {},
): Promise<boolean> {
  const org = deps.org ?? webhookOrg();
  const audit = deps.audit ?? appendAudit;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const key = rejectionThrottleKey(hook, rejection.status);

  let first = true;
  try {
    const markSeen =
      deps.markSeen ?? ((o: string, k: string, at: string, ttl: number) => getOperationalStore().markEventSeen(o, k, at, ttl));
    first = await markSeen(org, key, nowIso, REJECTION_WINDOW_MS);
  } catch {
    first = true;
  }

  if (!first) {
    suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
    return false;
  }

  const carried = suppressed.get(key) ?? 0;
  suppressed.delete(key);
  const target = hook?.target.split("/") ?? [];
  await audit({
    org,
    platform: "slack",
    workspace: hook ? (target[1] ?? "unknown") : "unknown",
    surface: hook ? (target[2] ?? "unknown") : "unknown",
    action: "webhook.rejected",
    detail: {
      hookId: id.slice(0, REJECTION_ID_MAX_CHARS),
      status: rejection.status,
      reason: rejection.reason,
      ...(carried > 0 ? { suppressed: carried, windowMs: REJECTION_WINDOW_MS } : {}),
    },
  });
  return true;
}
