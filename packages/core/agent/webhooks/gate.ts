import { createHmac, timingSafeEqual } from "node:crypto";
import { hookSecretRefs, type WebhookHook } from "./config.js";
import { webhookVerifier, registeredWebhookVerifierSources } from "./verifier.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export function webhookMaxBodyBytes(): number {
  const raw = process.env.OE_WEBHOOK_MAX_BODY_BYTES;
  if (raw === undefined) return DEFAULT_MAX_BODY_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

export function verifyWebhookSignature(secret: string, body: string, signatureHeader: string | null | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WebhookRejection {
  readonly status: number;
  readonly reason: string;
}

export type WebhookGateOutcome =
  | { readonly ok: true; readonly keyIndex: number | null; readonly replayKey?: string }
  | { readonly ok: false; readonly rejection: WebhookRejection };

export interface WebhookGateInput {
  readonly hook: WebhookHook | undefined;
  readonly secretValues: readonly string[];
  readonly rawBody: string;
  readonly bodyBytes: number;
  readonly headers: Headers;
  readonly nowMs: number;
  readonly allowUnverified: boolean;
  readonly maxBodyBytes: number;
}

export async function gateWebhookDelivery(args: WebhookGateInput): Promise<WebhookGateOutcome> {
  const { hook, secretValues, rawBody, bodyBytes, headers, nowMs, allowUnverified, maxBodyBytes } = args;
  const reject = (status: number, reason: string): WebhookGateOutcome => ({ ok: false, rejection: { status, reason } });

  if (!hook) return reject(404, "unknown webhook id");
  if (bodyBytes > maxBodyBytes) return reject(413, `payload exceeds ${maxBodyBytes} bytes`);

  const verifier = webhookVerifier(hook.source);
  if (!verifier) {
    const registered = registeredWebhookVerifierSources();
    return reject(
      401,
      `no verifier registered for webhook source ${JSON.stringify(hook.source)} — registered sources: ${registered.length ? registered.join(", ") : "(none)"}. ` +
        `Refusing to authenticate with another source's scheme (fail closed).`,
    );
  }

  const keys = secretValues.filter((k) => k);
  if (keys.length === 0) {
    const currentRef = hookSecretRefs(hook)[0] ?? "(none)";
    return allowUnverified
      ? { ok: true, keyIndex: null }
      : reject(401, `${currentRef} is not set — rejecting unverified delivery (set the secret, or OE_ALLOW_UNVERIFIED_WEBHOOK=1 for local dev)`);
  }

  let verdict;
  try {
    verdict = await verifier.verify({ rawBody, headers, keys, nowMs });
  } catch (err) {
    return reject(401, `verifier for source ${JSON.stringify(hook.source)} THREW — rejecting (fail closed): ${String(err instanceof Error ? err.message : err)}`);
  }
  return verdict.ok
    ? { ok: true, keyIndex: verdict.keyIndex, replayKey: verifier.signedTimestamp ? verdict.replayKey : undefined }
    : reject(401, `invalid signature (${verdict.failure})`);
}
