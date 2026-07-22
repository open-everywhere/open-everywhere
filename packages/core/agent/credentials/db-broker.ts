import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { CredentialError, registerBroker, registeredBrokerNames, type CredentialBroker } from "../access/credentials.js";
import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg } from "../identity/binding.js";
import { registerCredentialHome } from "./home.js";

export const DB_BROKER = "db";

export const CREDENTIAL_KEY_ENV = "OE_CREDENTIAL_ENCRYPTION_KEY";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const raw = process.env[CREDENTIAL_KEY_ENV];
  if (!raw) {
    throw new CredentialError(
      `db credential broker: ${CREDENTIAL_KEY_ENV} is not set — refusing to store or read credentials ` +
        `(fail closed). Set it to a base64-encoded 32-byte key.`,
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new CredentialError(`db credential broker: ${CREDENTIAL_KEY_ENV} is not valid base64 — refusing (fail closed).`);
  }
  if (key.length !== KEY_BYTES) {
    throw new CredentialError(
      `db credential broker: ${CREDENTIAL_KEY_ENV} decodes to ${key.length} bytes, need ${KEY_BYTES} ` +
        `(a base64-encoded 32-byte AES-256 key) — refusing (fail closed).`,
    );
  }
  return key;
}

export function encryptCredential(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptCredential(envelope: string): string {
  const key = loadKey();
  let buf: Buffer;
  try {
    buf = Buffer.from(envelope, "base64");
  } catch {
    throw new CredentialError("db credential broker: stored ciphertext is not valid base64 — refusing (fail closed).");
  }
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new CredentialError("db credential broker: stored ciphertext is truncated — refusing (fail closed).");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialError("db credential broker: ciphertext failed authentication (wrong key or tampered) — refusing (fail closed).");
  }
}

export interface StoreDbSecretInput {
  readonly org: string;
  readonly ref: string;
  readonly plaintext: string;
  readonly provider?: string;
  readonly domain?: string;
  readonly createdBy: string;
  readonly at?: string;
}

export async function storeDbSecret(input: StoreDbSecretInput): Promise<void> {
  const ciphertext = encryptCredential(input.plaintext);
  await getOperationalStore().putStoredCredential(input.org, {
    ref: input.ref,
    ciphertext,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.domain ? { domain: input.domain } : {}),
    createdBy: input.createdBy,
    createdAt: input.at ?? new Date().toISOString(),
  });
}

export function makeDbCredentialBroker(): CredentialBroker {
  return {
    async getSecret(ref) {
      const row = await getOperationalStore().getStoredCredential(deploymentOrg(), ref);
      if (!row) {
        throw new CredentialError(`secret not found for ref "${ref}" (no stored credential — store one via the "Set API key" flow)`);
      }
      return decryptCredential(row.ciphertext);
    },
  };
}

export function registerDbCredentialBroker(): void {
  registerBroker(DB_BROKER, makeDbCredentialBroker());
}

registerCredentialHome({
  name: DB_BROKER,
  hostWriteAvailable: () => registeredBrokerNames().includes(DB_BROKER),
  async store(input) {
    await storeDbSecret({
      org: input.org,
      ref: input.ref,
      plaintext: input.plaintext,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      createdBy: input.createdBy,
    });
  },
});
