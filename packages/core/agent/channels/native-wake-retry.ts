import { randomUUID } from "node:crypto";

import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { withRetryAfterThrown } from "./rate-limit-retry.js";
import {
  WAKE_DISPATCH_OPERATION,
  WAKE_DISPATCH_RETRY_POLICY,
  WAKE_RETRY_ACTION,
  wakeRetryDetail,
} from "./wake-timing.js";

export interface NativeWakeRetryAttribution {
  readonly platform: string;
  readonly workspace: string;
  readonly surfaceKey: string;
}

export async function dispatchNativeWakeWithRetry<T>(
  send: () => Promise<T>,
  attribution: NativeWakeRetryAttribution,
): Promise<T> {
  const deliveryId = randomUUID();
  return withRetryAfterThrown(send, {
    surface: attribution.platform,
    operation: WAKE_DISPATCH_OPERATION,
    ...WAKE_DISPATCH_RETRY_POLICY,
    onRefusal: (refusal) =>
      appendAudit({
        org: deploymentOrg(),
        platform: attribution.platform,
        workspace: attribution.workspace,
        surface: attribution.surfaceKey,
        action: WAKE_RETRY_ACTION,
        detail: wakeRetryDetail({
          deliveryId,
          surfaceKey: attribution.surfaceKey,
          attempt: refusal.attempt,
          delayMs: refusal.delayMs,
          waitedMs: refusal.waitedMs,
          outcome: refusal.outcome,
          refusalStatus: refusal.refusalStatus,
        }),
      }).catch(() => undefined),
  });
}
