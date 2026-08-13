import { createHash, randomUUID } from "node:crypto";
import { deploymentOrg } from "../identity/binding.js";
import { encryptedKvVault } from "../credentials/kv-vault.js";
import { reservedRefNamespace } from "../credentials/reserved-refs.js";
import { issueRevealLink, revealPageAvailable, REVEAL_GRANT_TTL_MS } from "./reveal-page.js";

export const HANDSHAKE_REVEAL_PRINCIPAL = "operator:deploy-log";

export const FINGERPRINT_HEX_CHARS = 8;

export function secretFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, FINGERPRINT_HEX_CHARS);
}

export interface CaptureHandshakeSecretInput {
  readonly refNamespace: string;
  readonly label: string;
  readonly value: string;
}

export interface CaptureHandshakeSecretDeps {
  readonly org?: () => string;
  readonly writeSecret?: (ref: string, plaintext: string) => Promise<void>;
  readonly issueLink?: typeof issueRevealLink;
  readonly available?: typeof revealPageAvailable;
  readonly log?: (message: string) => void;
  readonly newId?: () => string;
}

export interface CaptureHandshakeSecretOutcome {
  readonly fingerprint: string;
  readonly ref?: string;
  readonly stored: boolean;
  readonly revealed: boolean;
}

export async function captureHandshakeSecret(
  input: CaptureHandshakeSecretInput,
  deps: CaptureHandshakeSecretDeps = {},
): Promise<CaptureHandshakeSecretOutcome> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const fingerprint = secretFingerprint(input.value);

  if (input.value.length === 0) {
    log(`handshake secret for ${input.label} REFUSED — the delivery carried no readable secret. Nothing was stored.`);
    return { fingerprint, stored: false, revealed: false };
  }

  if (reservedRefNamespace(input.refNamespace) !== input.refNamespace) {
    log(
      `handshake secret for ${input.label} REFUSED (fingerprint ${fingerprint}) — the ref namespace ` +
        `${JSON.stringify(input.refNamespace)} is not reserved, and a signing key stored outside a reserved ` +
        `namespace would be resolvable as an OUTBOUND credential. Nothing was stored and the value is NOT logged; ` +
        `delete and recreate the subscription once the namespace is registered in RESERVED_REF_NAMESPACES.`,
    );
    return { fingerprint, stored: false, revealed: false };
  }

  const ref = `${input.refNamespace}${(deps.newId ?? randomUUID)()}`;
  const write = deps.writeSecret ?? ((r: string, v: string) => encryptedKvVault().write(r, v, { provider: "handshake-capture", domain: input.label }));
  await write(ref, input.value);

  const available = (deps.available ?? revealPageAvailable)();
  const link = available
    ? await (deps.issueLink ?? issueRevealLink)({
        org: (deps.org ?? deploymentOrg)(),
        ref,
        revealTo: HANDSHAKE_REVEAL_PRINCIPAL,
        label: input.label,
      })
    : undefined;

  if (!link) {
    log(
      `handshake secret for ${input.label} received and STORED — NOT logged (sha256 fingerprint ${fingerprint}). ` +
        `It cannot be shown to you because the one-shot reveal page is not configured on this deployment: arm ` +
        `OE_CREDENTIAL_ENCRYPTION_KEY and set OE_PUBLIC_BASE_URL, then delete and recreate the subscription so ` +
        `the vendor sends a fresh handshake. The value will not be printed under any circumstance.`,
    );
    return { fingerprint, ref, stored: true, revealed: false };
  }

  log(
    `handshake secret for ${input.label} received and STORED — NOT logged (sha256 fingerprint ${fingerprint}; ` +
      `confirm your env var with: printf %s "$SECRET" | sha256sum | cut -c1-${FINGERPRINT_HEX_CHARS}). ` +
      `Read it ONCE here, within ${Math.round(REVEAL_GRANT_TTL_MS / 60_000)} minutes — the link is single-use and ` +
      `whoever opens it first gets the secret, so treat it as the secret itself: ${link.url}`,
  );
  return { fingerprint, ref, stored: true, revealed: true };
}
