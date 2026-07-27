import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { registerWebhookVerifier, type WebhookVerdict, type WebhookVerifier, type WebhookVerifyInput } from "./verifier.js";
import { webhookMaxSkewSeconds } from "./oe-hmac.js";
import {
  FIELDS_MAX_KEYS,
  registerEventNormalizer,
  scopeIdOf,
  type EventNormalizer,
  type NormalizedEvent,
  type ScopeStep,
  type TriggerDelivery,
} from "../routines/event-model.js";
import { registerEventScopeGrant, type EventScopeGrant } from "../routines/event-authz.js";
import { registerWebhookProvisioning, type SetupExchange, type WebhookProvisioning } from "./provisioning.js";

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

export const standardWebhookVerifier: WebhookVerifier = {
  source: OE_STANDARD_WEBHOOK_SCHEME,
  keyKind: "shared-secret",
  keyOrigin: "receiver-minted",
  signedTimestamp: true,
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

export function standardWebhookScope(d: Pick<TriggerDelivery, "source" | "ownerDomain">): ScopeStep[] {
  const scope: ScopeStep[] = [];
  if (d.ownerDomain) scope.push({ kind: "tenant", id: d.ownerDomain });
  scope.push({ kind: "container", id: d.source });
  return scope;
}

function summarize(name: string, event: string, action: string | undefined): string {
  return `${name}: ${event}${action ? ` (${action})` : ""}`;
}

export const standardWebhookNormalizer: EventNormalizer = {
  source: OE_STANDARD_WEBHOOK_SCHEME,
  matchKeys: ["event", "action"],
  matchKeysOpen: true,
  scopeKeys: [],
  scopeKinds: ["tenant", "container"],
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

export const standardWebhookScopeGrant: EventScopeGrant = {
  source: OE_STANDARD_WEBHOOK_SCHEME,
  grantsRead(scope, access) {
    const owner = scopeIdOf(scope, "tenant");
    return owner !== undefined && access.domains.includes(owner);
  },
};

export const standardWebhookProvisioning: WebhookProvisioning = {
  source: OE_STANDARD_WEBHOOK_SCHEME,
  acquisition: "mint",
  cardinality: "per-hook",
  remediation: "remint",
};

registerWebhookVerifier(standardWebhookVerifier);
registerEventNormalizer(standardWebhookNormalizer);
registerEventScopeGrant(standardWebhookScopeGrant);
registerWebhookProvisioning(standardWebhookProvisioning);
