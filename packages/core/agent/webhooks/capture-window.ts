import { filterDocument, type EventFilterDocument } from "../routines/jq-filter.js";
import type { NormalizedEvent } from "../routines/event-model.js";
import { CAPTURE_MAX_WINDOW_MS } from "../operational/store.js";
import { getOperationalStore } from "../operational/provider.js";
import type { WebhookPosture } from "./config.js";

export interface CaptureSubject {
  readonly source: string;
  readonly posture: WebhookPosture;
}

const CAPTURE_WINDOW_DEFAULT_MS = 15 * 60_000;

export const CAPTURE_DOCUMENT_MAX_CHARS = 16_384;

export type CaptureArmRefusal = string;

export function captureDeadline(now: Date, requestedMs: number = CAPTURE_WINDOW_DEFAULT_MS): string {
  const asked = Number.isFinite(requestedMs) ? requestedMs : CAPTURE_WINDOW_DEFAULT_MS;
  const ms = Math.min(Math.max(Math.trunc(asked), 1_000), CAPTURE_MAX_WINDOW_MS);
  return new Date(now.getTime() + ms).toISOString();
}

export function refuseCaptureArm(hook: CaptureSubject): CaptureArmRefusal | undefined {
  if (hook.posture === "trigger-only") {
    return (
      `"${hook.source}" is a trigger-only webhook: its payload is discarded at the door and is never rendered, stored or ` +
      "shown to anyone. A capture window would be a storage back door around exactly that guarantee, so it is refused rather " +
      "than quietly recording nothing. If this hook's payload genuinely should be readable, its declaration has to say so — " +
      "changing the posture is a reviewed diff, which is the point."
    );
  }
  return undefined;
}

export function captureWindowOpen(until: string | undefined, now: Date): boolean {
  if (!until) return false;
  const ms = Date.parse(until);
  return Number.isFinite(ms) && now.getTime() < ms;
}

export async function captureDeclaration(
  org: string,
  hook: CaptureSubject & { readonly id: string },
  now: Date,
  deps: { readonly getWindow?: (org: string, hookId: string) => Promise<{ readonly captureUntil: string } | null> } = {},
): Promise<string | undefined> {
  if (hook.posture === "trigger-only") return undefined;
  let until: string | undefined;
  try {
    const row = await (deps.getWindow ?? ((o: string, h: string) => getOperationalStore().getWebhookCaptureWindow(o, h)))(org, hook.id);
    until = row?.captureUntil;
  } catch {
    return undefined;
  }
  if (!captureWindowOpen(until, now)) return undefined;
  return until;
}

export function captureDocument(ev: NormalizedEvent): string | undefined {
  if (ev.redacted === true) return undefined;
  const doc: EventFilterDocument = filterDocument(ev);
  const json = JSON.stringify(doc);
  if (json.length > CAPTURE_DOCUMENT_MAX_CHARS) return undefined;
  return json;
}
