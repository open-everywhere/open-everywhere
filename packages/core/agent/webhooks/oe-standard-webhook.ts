import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { registerWebhookVerifier, type WebhookSenderGuidance, type WebhookVerdict, type WebhookVerifier, type WebhookVerifyInput } from "./verifier.js";
import { webhookMaxSkewSeconds } from "./gate.js";
import {
  FIELDS_MAX_KEYS,
  registerEventNormalizer,
  type EventNormalizer,
  type NormalizedEvent,
  type ScopeStep,
  type TriggerDelivery,
} from "../routines/event-model.js";

export const OE_STANDARD_WEBHOOK_SCHEME = "oe-standard-webhook";

export const SW_ID_HEADER = "webhook-id";
export const SW_TIMESTAMP_HEADER = "webhook-timestamp";
export const SW_SIGNATURE_HEADER = "webhook-signature";

export const SW_SIGNATURE_VERSION = "v1";

export const SW_SECRET_PREFIX = "whsec_";

const TIMESTAMP_RE = /^[0-9]{1,15}$/;

const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-+=]{0,127}$/;

export function standardWebhookSignedContent(messageId: string, timestamp: string, rawBody: string): string {
  return `${messageId}.${timestamp}.${rawBody}`;
}

export function standardWebhookKey(secret: string): Buffer {
  return secret.startsWith(SW_SECRET_PREFIX) ? Buffer.from(secret.slice(SW_SECRET_PREFIX.length), "base64") : Buffer.from(secret, "utf8");
}

const SW_SECRET_BYTES = 33;

export function mintStandardWebhookSecret(bytes: Buffer = randomBytes(SW_SECRET_BYTES)): string {
  return SW_SECRET_PREFIX + bytes.toString("base64");
}

export function standardWebhookSignature(secret: string, messageId: string, timestamp: string, rawBody: string): string {
  const mac = createHmac("sha256", standardWebhookKey(secret)).update(standardWebhookSignedContent(messageId, timestamp, rawBody), "utf8").digest("base64");
  return `${SW_SIGNATURE_VERSION},${mac}`;
}

export function standardWebhookReplayKey(messageId: string): string {
  return createHash("sha256").update(`${OE_STANDARD_WEBHOOK_SCHEME}:${messageId}`).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function standardWebhookSenderGuidance(): WebhookSenderGuidance {
  return {
    headers: [
      { name: SW_ID_HEADER, value: "<a unique id for this delivery, e.g. msg_01J8Z…>" },
      { name: SW_TIMESTAMP_HEADER, value: "<unix seconds, digits only, e.g. 1614265330>" },
      { name: SW_SIGNATURE_HEADER, value: `${SW_SIGNATURE_VERSION},<base64 signature>` },
    ],
    signedContent: standardWebhookSignedContent(`<${SW_ID_HEADER}>`, `<${SW_TIMESTAMP_HEADER}>`, "<the raw request body, byte for byte>"),
    notes: [
      `This is the Standard Webhooks scheme — any client library for it will do all of the below if you hand it the whole secret.`,
      `Key bytes: if the secret starts with "${SW_SECRET_PREFIX}", drop that prefix and base64-decode the rest; otherwise use the secret's own text.`,
      `Signature: HMAC-SHA256, base64-encoded, tagged "${SW_SIGNATURE_VERSION},". You may send several space-separated values while rotating a key — any one that matches is accepted.`,
      `The timestamp must be within ${webhookMaxSkewSeconds()} seconds of our clock, and it is signed exactly as sent — do not reformat it between signing and sending.`,
      `Give every delivery a NEW id: an id that has been accepted before is rejected as a replay. Ids are letters, digits and "_.-+=" only.`,
      `Send the body verbatim. Re-serialising the JSON changes the bytes and the signature will not match.`,
      `In a shell: KEY=$(printf '%s' "\${SECRET#${SW_SECRET_PREFIX}}" | base64 -d | od -An -tx1 | tr -d ' \\n') ` +
        `then SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -binary | base64)`,
    ],
  };
}

export const standardWebhookVerifier: WebhookVerifier = {
  source: OE_STANDARD_WEBHOOK_SCHEME,
  keyKind: "shared-secret",
  keyOrigin: "receiver-minted",
  signedTimestamp: true,
  mintSecret: () => mintStandardWebhookSecret(),
  senderGuidance: standardWebhookSenderGuidance,
  verify({ rawBody, headers, keys, nowMs }: WebhookVerifyInput): WebhookVerdict {
    const messageId = headers.get(SW_ID_HEADER);
    const timestamp = headers.get(SW_TIMESTAMP_HEADER);
    const signatureHeader = headers.get(SW_SIGNATURE_HEADER);
    if (!signatureHeader) return { ok: false, failure: "missing-signature" };
    if (messageId === null) return { ok: false, failure: "missing-signature" };
    if (!MESSAGE_ID_RE.test(messageId)) return { ok: false, failure: "malformed-signature" };
    if (timestamp === null) return { ok: false, failure: "missing-timestamp" };
    if (!TIMESTAMP_RE.test(timestamp)) return { ok: false, failure: "malformed-timestamp" };
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > webhookMaxSkewSeconds()) return { ok: false, failure: "stale-timestamp" };

    const presented = signatureHeader.split(" ").filter((s) => s.length > 0);
    if (presented.length === 0) return { ok: false, failure: "malformed-signature" };
    const v1 = presented.filter((s) => s.startsWith(`${SW_SIGNATURE_VERSION},`));
    if (v1.length === 0) return { ok: false, failure: "unsupported-scheme" };
    for (const [i, key] of keys.entries()) {
      const expected = standardWebhookSignature(key, messageId, timestamp, rawBody);
      for (const candidate of v1) {
        if (constantTimeEquals(candidate, expected)) {
          return { ok: true, keyIndex: i, replayKey: standardWebhookReplayKey(messageId) };
        }
      }
    }
    return { ok: false, failure: "signature-mismatch" };
  },
};

export interface StandardWebhookEnvelope {
  readonly event: string;
  readonly action?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function mergeScalarFields(into: Record<string, string>, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(into).length >= FIELDS_MAX_KEYS) break;
    if (k in into) continue;
    if (typeof v === "string") into[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) into[k] = String(v);
    else if (typeof v === "boolean") into[k] = String(v);
  }
}

export function standardWebhookScope(d: Pick<TriggerDelivery, "source">): ScopeStep[] {
  return [{ kind: "container", id: d.source }];
}

function summarize(name: string, event: string, action: string | undefined): string {
  return `${name}: ${event}${action ? ` (${action})` : ""}`;
}

export const standardWebhookNormalizer: EventNormalizer = {
  source: OE_STANDARD_WEBHOOK_SCHEME,
  matchKeys: ["event", "action"],
  matchKeysOpen: true,
  scopeKeys: [],
  scopeKinds: ["container"],
  scopeHookConstant: true,
  resolvesActor: false,
  deliveryIdHeader: SW_ID_HEADER,
  normalize(d: TriggerDelivery): NormalizedEvent | null {
    let payload: unknown;
    try {
      payload = JSON.parse(d.body);
    } catch {
      return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const env = payload as Record<string, unknown>;
    const event = str(env["event"]);
    if (!event) return null;
    const action = str(env["action"]);
    const occurredAt = str(env["occurredAt"]);
    const fields: Record<string, string> = { event, ...(action ? { action } : {}) };
    mergeScalarFields(fields, env["fields"]);
    return {
      source: d.source,
      event,
      ...(action ? { action } : {}),
      scope: standardWebhookScope(d),
      fields,
      ...(d.deliveryId ? { deliveryId: d.deliveryId } : {}),
      ...(occurredAt && !Number.isNaN(Date.parse(occurredAt)) ? { occurredAt } : {}),
      summary: summarize(d.source, event, action),
    };
  },
};

registerWebhookVerifier(standardWebhookVerifier);
registerEventNormalizer(standardWebhookNormalizer);
