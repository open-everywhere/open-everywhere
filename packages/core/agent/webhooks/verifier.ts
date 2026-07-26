import { admitProviderRegistration } from "../access/provider-selection.js";

export interface WebhookVerifyInput {
  readonly rawBody: string;
  readonly headers: Headers;
  readonly keys: readonly string[];
  readonly nowMs: number;
}

export type WebhookVerifyFailure =
  | "missing-signature"
  | "malformed-signature"
  | "signature-mismatch"
  | "missing-timestamp"
  | "malformed-timestamp"
  | "stale-timestamp"
  | "unsupported-scheme";

export type WebhookVerdict =
  | { readonly ok: true; readonly keyIndex: number; readonly replayKey?: string }
  | { readonly ok: false; readonly failure: WebhookVerifyFailure };

export interface WebhookVerifier {
  readonly source: string;
  readonly provider?: string;
  readonly keyKind: "shared-secret" | "public-key";
  readonly signedTimestamp: boolean;
  verify(input: WebhookVerifyInput): Promise<WebhookVerdict> | WebhookVerdict;
}

const VERIFIERS = new Map<string, WebhookVerifier>();

export function registerWebhookVerifier(verifier: WebhookVerifier): boolean {
  if (verifier.provider !== undefined && !admitProviderRegistration(verifier.provider, "webhook-verifier")) return false;
  VERIFIERS.set(verifier.source, verifier);
  return true;
}

export function webhookVerifier(source: string | undefined): WebhookVerifier | undefined {
  return source === undefined ? undefined : VERIFIERS.get(source);
}

export function registeredWebhookVerifierSources(): readonly string[] {
  return [...VERIFIERS.keys()].sort();
}

export function registeredWebhookVerifiers(): readonly WebhookVerifier[] {
  return [...VERIFIERS.values()];
}

export function resetWebhookVerifiersForTest(): void {
  VERIFIERS.clear();
}
