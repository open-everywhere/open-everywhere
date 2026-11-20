import { OE_WORK_REQUEST_ATTR } from "../channels/work.js";
import { OE_DELIVERY_ID_ATTR } from "../channels/unified-window.js";
import { eveContextContainer } from "./wake-slot.js";

export type WorkStampFailure = "stamp-names-another-request" | "stamp-absent";

export type WorkStampVerdict =
  | { readonly kind: "keyed"; readonly requestId: string }
  | { readonly kind: "needs-reissue"; readonly requestId: string; readonly reason: WorkStampFailure; readonly stamped?: string };

export function workStampVerdict(joined: string, stamped: string | undefined): WorkStampVerdict {
  if (stamped === undefined || stamped.length === 0) return { kind: "needs-reissue", requestId: joined, reason: "stamp-absent" };
  if (stamped !== joined) return { kind: "needs-reissue", requestId: joined, reason: "stamp-names-another-request", stamped };
  return { kind: "keyed", requestId: joined };
}

export const WORK_CALL_NEEDS_REISSUE_MESSAGE =
  "agent: this job was NOT started. It reached this work session in an earlier step, so this step cannot start it under its own " +
  "requester. OE delivers it to you again; start it when a step delivers it. Do not retry it now; start only the job this step delivered.";

const EVE_AUTH_KEY_NAME = "eve.auth";

function firstString(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

export function liveWorkRequestStamp(): string | undefined {
  return liveStepAttr(OE_WORK_REQUEST_ATTR);
}

export function liveStepDeliveryId(): string | undefined {
  return liveStepAttr(OE_DELIVERY_ID_ATTR);
}

function liveStepAttr(name: string): string | undefined {
  try {
    const container = eveContextContainer() as { get?: (key: { readonly name: string }) => unknown } | undefined;
    if (container === undefined || container === null || typeof container.get !== "function") return undefined;
    const auth = container.get({ name: EVE_AUTH_KEY_NAME }) as { attributes?: Record<string, unknown>; current?: { attributes?: Record<string, unknown> } } | null | undefined;
    const attrs = auth?.attributes ?? auth?.current?.attributes;
    return firstString(attrs?.[name]);
  } catch {
    return undefined;
  }
}

export type WorkReissuer = (input: { readonly requestId: string; readonly reason: WorkStampFailure; readonly stamped?: string; readonly deliveryId?: string }) => Promise<"redelivered" | "seat" | "replay">;

let registeredReissuer: WorkReissuer | undefined;

export function registerWorkReissuer(reissue: WorkReissuer): void {
  registeredReissuer = reissue;
}

export function registeredWorkReissuer(): WorkReissuer | undefined {
  return registeredReissuer;
}

export async function gateWorkCallStamp(joined: string, stamped: string | undefined = liveWorkRequestStamp(), reissue: WorkReissuer | null = registeredReissuer ?? null): Promise<WorkStampVerdict> {
  const verdict = workStampVerdict(joined, stamped);
  if (verdict.kind === "needs-reissue") {
    console.warn(`[open-everywhere:work] agent call for request ${joined} REFUSED at validate (${verdict.reason}${verdict.stamped !== undefined ? `: the step carries ${verdict.stamped}` : ""}) — the job is reissued`);
    const deliveryId = liveStepDeliveryId();
    if (reissue === null) {
      console.error(`[open-everywhere:work] request ${joined}: NO reissuer is registered (hooks/work-task-key.ts did not load), so the refused job is neither re-sent nor reported to the seat`);
      return verdict;
    }
    await reissue({ requestId: joined, reason: verdict.reason, ...(verdict.stamped !== undefined ? { stamped: verdict.stamped } : {}), ...(deliveryId !== undefined ? { deliveryId } : {}) }).catch(() => "seat" as const);
  }
  return verdict;
}
