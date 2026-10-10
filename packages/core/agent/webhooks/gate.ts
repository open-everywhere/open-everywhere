import { createHmac, timingSafeEqual } from "node:crypto";
import { hookSecretRefs } from "./config.js";
import { webhookVerifier, registeredWebhookVerifierSources, webhookAuthCeiling, meetsWebhookAuthFloor, type WebhookAuthGrade } from "./verifier.js";
import { webhookScheme } from "../routines/scheme-name.js";

const MAX_BODY_BYTES = 256 * 1024;

export function webhookMaxBodyBytes(): number {
  return MAX_BODY_BYTES;
}

const MAX_SKEW_SECONDS = 300;

export function webhookMaxSkewSeconds(): number {
  return MAX_SKEW_SECONDS;
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

const UNKNOWN_HOOK_REJECTION: WebhookRejection = { status: 404, reason: "unknown webhook id" };

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
  readonly broker: string;
  readonly authFloor?: WebhookAuthGrade;
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

  if (!hook) return { ok: false, rejection: UNKNOWN_HOOK_REJECTION };
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

  const floor = hook.authFloor;
  if (floor !== undefined) {
    const ceiling = webhookAuthCeiling(verifier);
    if (!meetsWebhookAuthFloor(ceiling, floor)) {
      return reject(
        401,
        `webhook "${hook.id}" declares authFloor ${JSON.stringify(floor)}, and no delivery on scheme ${JSON.stringify(scheme)} can ever reach it — ` +
          `the strongest acceptance that scheme offers is ${JSON.stringify(ceiling)} (its verifier declares signedTimestamp: ${verifier.signedTimestamp}). ` +
          `Refusing every delivery rather than accepting one below the declared floor (fail closed). ` +
          `Lower the floor, or declare a source whose scheme signs a timestamp.`,
      );
    }
  }

  const keys = secretValues.filter((k) => k);
  if (keys.length === 0) {
    const hatch = allowUnverified && hook.broker === "env";
    const currentRef = hookSecretRefs(hook)[0] ?? "(none)";
    if (hatch) {
      if (floor !== undefined && !meetsWebhookAuthFloor("unverified", floor)) {
        return reject(
          401,
          `webhook "${hook.id}" declares authFloor ${JSON.stringify(floor)}, so the local-dev hatch cannot accept this delivery — ` +
            `an acceptance with no resolvable key checks no signature at all ("unverified"), which is below the declared floor. ` +
            `Refusing rather than downgrading (fail closed). Set ${currentRef}, or drop the hook's authFloor.`,
        );
      }
      return { ok: true, keyIndex: null };
    }
    return reject(
      401,
      hook.broker !== "env"
        ?
          `${currentRef} did not resolve through the "${hook.broker}" broker — rejecting unverified delivery (issue this hook a signing secret with rotate_webhook, which stores one and shows it once)`
        : `${currentRef} is not set — rejecting unverified delivery (set the secret, or turn on webhooks.allowUnverified in agent/settings/settings.ts for local dev)`,
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
