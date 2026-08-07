import { encryptCredential, decryptCredential, DB_BROKER } from "./db-broker.js";
import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg } from "../identity/binding.js";
import type { StoredCredentialRow } from "../operational/store.js";

export interface EncryptedKvVault {
  read(ref: string): Promise<string | null>;
  write(ref: string, plaintext: string, labels?: { provider?: string; domain?: string; createdBy?: string }): Promise<void>;
  delete(ref: string): Promise<boolean>;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  claim(ref: string, claimId: string, nowMs: number, leaseTtlMs: number): Promise<boolean>;
  releaseClaim(ref: string, claimId: string): Promise<void>;
}

export interface EncryptedKvVaultDeps {
  readonly getStore?: () => Pick<ReturnType<typeof getOperationalStore>, "getStoredCredential" | "putStoredCredential" | "deleteStoredCredential" | "claimStoredCredential" | "releaseStoredCredential">;
  readonly org?: () => string;
  readonly encrypt?: (plaintext: string) => string;
  readonly decrypt?: (envelope: string) => string;
}

const lockTails = new Map<string, Promise<void>>();

async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => mine);
  lockTails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

export function encryptedKvVault(deps: EncryptedKvVaultDeps = {}): EncryptedKvVault {
  const store = deps.getStore ?? getOperationalStore;
  const org = deps.org ?? deploymentOrg;
  const encrypt = deps.encrypt ?? encryptCredential;
  const decrypt = deps.decrypt ?? decryptCredential;
  return {
    async read(ref) {
      const row = await store().getStoredCredential(org(), ref);
      if (!row) return null;
      return decrypt(row.ciphertext);
    },
    async write(ref, plaintext, labels) {
      const ciphertext = encrypt(plaintext);
      const rec: StoredCredentialRow = {
        ref,
        ciphertext,
        ...(labels?.provider ? { provider: labels.provider } : {}),
        ...(labels?.domain ? { domain: labels.domain } : {}),
        createdBy: labels?.createdBy ?? DB_BROKER,
        createdAt: new Date().toISOString(),
      };
      await store().putStoredCredential(org(), rec);
    },
    async delete(ref) {
      return store().deleteStoredCredential(org(), ref);
    },
    withLock: withKeyedLock,
    async claim(ref, claimId, nowMs, leaseTtlMs) {
      const claimedAtIso = new Date(nowMs).toISOString();
      const staleBeforeIso = new Date(nowMs - leaseTtlMs).toISOString();
      return store().claimStoredCredential(org(), ref, claimId, claimedAtIso, staleBeforeIso);
    },
    async releaseClaim(ref, claimId) {
      await store().releaseStoredCredential(org(), ref, claimId);
    },
  };
}
