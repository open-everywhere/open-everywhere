import { filterDocument, type EventFilterDocument } from "../routines/jq-filter.js";
import type { NormalizedEvent } from "../routines/event-model.js";
import { CAPTURE_MAX_WINDOW_MS } from "../operational/store.js";
import type { RuntimeWebhookHook } from "./runtime-hook.js";

export const CAPTURE_WINDOW_DEFAULT_MS = 15 * 60_000;

export const CAPTURE_DOCUMENT_MAX_CHARS = 16_384;

export type CaptureArmRefusal = string;

export function captureDeadline(now: Date, requestedMs: number = CAPTURE_WINDOW_DEFAULT_MS): string {
  const asked = Number.isFinite(requestedMs) ? requestedMs : CAPTURE_WINDOW_DEFAULT_MS;
  const ms = Math.min(Math.max(Math.trunc(asked), 1_000), CAPTURE_MAX_WINDOW_MS);
  return new Date(now.getTime() + ms).toISOString();
}

export function refuseCaptureArm(hook: Pick<RuntimeWebhookHook, "source" | "posture">): CaptureArmRefusal | undefined {
  if (hook.posture === "trigger-only") {
    return (
      `"${hook.source}" is a trigger-only webhook: its payload is discarded at the door and is never rendered, stored or ` +
      "shown to anyone. A capture window would be a storage back door around exactly that guarantee, so it is refused rather " +
      "than quietly recording nothing. If this hook's payload genuinely should be readable, re-create it as content-bearing " +
      "— that is a decision with an approval behind it, which is the point."
    );
  }
  return undefined;
}

export function captureWindowOpen(hook: Pick<RuntimeWebhookHook, "captureUntil">, now: Date): boolean {
  const until = hook.captureUntil;
  if (!until) return false;
  const ms = Date.parse(until);
  return Number.isFinite(ms) && now.getTime() < ms;
}

export function captureDeclaration(hook: Pick<RuntimeWebhookHook, "posture" | "captureUntil">, now: Date): string | undefined {
  if (hook.posture === "trigger-only") return undefined;
  if (!captureWindowOpen(hook, now)) return undefined;
  return hook.captureUntil;
}

export function captureDocument(ev: NormalizedEvent): string | undefined {
  if (ev.redacted === true) return undefined;
  const doc: EventFilterDocument = filterDocument(ev);
  const json = JSON.stringify(doc);
  if (json.length > CAPTURE_DOCUMENT_MAX_CHARS) return undefined;
  return json;
}
