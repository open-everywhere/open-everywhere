export const NOTION_WEBHOOK_TIMING_ACTION = "notion.webhook_timing";

export type NotionWebhookTimingPhase =
  | "credential"
  | "botTriggerPage"
  | "ancestorSiblingTrust"
  | "engagementDedupe"
  | "dispatch"
  | "eveSend"
  | "finalAudit";

export interface NotionWebhookTimingDetail {
  readonly [key: string]: unknown;
  readonly outcome: string;
  readonly failedPhase?: NotionWebhookTimingPhase;
  readonly hmacCredentialMs?: number;
  readonly botTriggerPageMs?: number;
  readonly ancestorSiblingTrustMs?: number;
  readonly engagementStoreDedupeMs?: number;
  readonly dispatchPreflightCatchUpMs?: number;
  readonly eveSendMs?: number;
  readonly finalAuditMs?: number;
  readonly totalMs: number;
}

export interface NotionWebhookTimingRecorder {
  readonly measure: <T>(phase: NotionWebhookTimingPhase, operation: () => Promise<T>) => Promise<T>;
  readonly measureSync: <T>(phase: NotionWebhookTimingPhase, operation: () => T) => T;
  readonly detail: (outcome: string) => NotionWebhookTimingDetail;
}

export async function runNotionWebhookTimed<T>(
  timing: NotionWebhookTimingRecorder,
  emit: (detail: NotionWebhookTimingDetail) => void,
  operation: (finish: (outcome: string) => void) => Promise<T>,
): Promise<T> {
  let emitted = false;
  const finish = (outcome: string): void => {
    if (emitted) return;
    emitted = true;
    try {
      emit(timing.detail(outcome));
    } catch {
    }
  };
  try {
    return await operation(finish);
  } catch (err) {
    finish("threw");
    throw err;
  }
}

function duration(start: number, end: number): number {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

const millis = (elapsed: number): number => Math.round(elapsed);

export function createNotionWebhookTiming(now: () => number = () => performance.now()): NotionWebhookTimingRecorder {
  const startedAt = now();
  const elapsed = new Map<NotionWebhookTimingPhase, number>();
  let failedPhase: NotionWebhookTimingPhase | undefined;
  const add = (phase: NotionWebhookTimingPhase, start: number): void => {
    elapsed.set(phase, (elapsed.get(phase) ?? 0) + duration(start, now()));
  };

  return {
    async measure<T>(phase: NotionWebhookTimingPhase, operation: () => Promise<T>): Promise<T> {
      const start = now();
      try {
        return await operation();
      } catch (err) {
        failedPhase ??= phase;
        throw err;
      } finally {
        add(phase, start);
      }
    },
    measureSync<T>(phase: NotionWebhookTimingPhase, operation: () => T): T {
      const start = now();
      try {
        return operation();
      } catch (err) {
        failedPhase ??= phase;
        throw err;
      } finally {
        add(phase, start);
      }
    },
    detail(outcome: string): NotionWebhookTimingDetail {
      const eveSendMs = elapsed.get("eveSend");
      const finalAuditMs = elapsed.get("finalAudit");
      const dispatchMs = elapsed.get("dispatch");
      return {
        outcome,
        ...(failedPhase ? { failedPhase } : {}),
        ...(elapsed.has("credential") ? { hmacCredentialMs: millis(elapsed.get("credential")!) } : {}),
        ...(elapsed.has("botTriggerPage") ? { botTriggerPageMs: millis(elapsed.get("botTriggerPage")!) } : {}),
        ...(elapsed.has("ancestorSiblingTrust") ? { ancestorSiblingTrustMs: millis(elapsed.get("ancestorSiblingTrust")!) } : {}),
        ...(elapsed.has("engagementDedupe") ? { engagementStoreDedupeMs: millis(elapsed.get("engagementDedupe")!) } : {}),
        ...(dispatchMs === undefined
          ? {}
          : { dispatchPreflightCatchUpMs: millis(Math.max(0, dispatchMs - (eveSendMs ?? 0) - (finalAuditMs ?? 0))) }),
        ...(eveSendMs === undefined ? {} : { eveSendMs: millis(eveSendMs) }),
        ...(finalAuditMs === undefined ? {} : { finalAuditMs: millis(finalAuditMs) }),
        totalMs: millis(duration(startedAt, now())),
      };
    },
  };
}
