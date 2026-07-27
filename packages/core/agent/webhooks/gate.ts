import { createHmac, timingSafeEqual } from "node:crypto";
import { hookSecretRefs } from "./config.js";
import { isRuntimeHookId } from "./runtime-hook.js";
import { webhookVerifier, registeredWebhookVerifierSources } from "./verifier.js";
import { webhookScheme } from "../routines/scheme-name.js";

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

export function acceptedUnverified(outcome: WebhookGateOutcome): boolean {
  return outcome.ok && outcome.keyIndex === null;
}

export interface GateableHook {
  readonly id: string;
  readonly source: string;
  readonly scheme?: string;
  readonly secretRef: string | readonly string[];
}

export interface WebhookGateInput {
  readonly hook: GateableHook | undefined;
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

  const scheme = webhookScheme(hook);
  const verifier = webhookVerifier(scheme);
  if (!verifier) {
    const registered = registeredWebhookVerifierSources();
    return reject(
      401,
      `no verifier registered for webhook source ${JSON.stringify(scheme)} — registered sources: ${registered.length ? registered.join(", ") : "(none)"}. ` +
        `Refusing to authenticate with another source's scheme (fail closed).`,
    );
  }

  const keys = secretValues.filter((k) => k);
  if (keys.length === 0) {
    const hatch = allowUnverified && !isRuntimeHookId(hook.id);
    const currentRef = hookSecretRefs(hook)[0] ?? "(none)";
    if (hatch) return { ok: true, keyIndex: null };
    return reject(
      401,
      isRuntimeHookId(hook.id)
        ?
          `${currentRef} did not resolve — rejecting unverified delivery (a chat-created hook's secret is minted at creation; rotate the hook to mint a new one)`
        : `${currentRef} is not set — rejecting unverified delivery (set the secret, or OE_ALLOW_UNVERIFIED_WEBHOOK=1 for local dev)`,
    );
  }

  let verdict;
  try {
    verdict = await verifier.verify({ rawBody, headers, keys, nowMs });
  } catch (err) {
    return reject(401, `verifier for source ${JSON.stringify(scheme)} THREW — rejecting (fail closed): ${String(err instanceof Error ? err.message : err)}`);
  }
  return verdict.ok
    ? { ok: true, keyIndex: verdict.keyIndex, replayKey: verifier.signedTimestamp ? verdict.replayKey : undefined }
    : reject(401, `invalid signature (${verdict.failure})`);
}
