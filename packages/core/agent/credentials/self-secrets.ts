import { randomBytes } from "node:crypto";
import { encryptedKvVault, type EncryptedKvVault } from "./kv-vault.js";
import { credentialKeyArmed, CREDENTIAL_KEY_ENV } from "./db-broker.js";
import { CredentialError } from "../access/credentials.js";
import { SELF_SECRET_REF_NAMESPACE } from "./reserved-refs.js";

export interface SelfSecretDeps {
  readonly vault?: EncryptedKvVault;
  readonly env?: NodeJS.ProcessEnv;
}

const envOnrampWarned = new Set<string>();

export function resetSelfSecretWarnings(): void {
  envOnrampWarned.clear();
}

const resolvedCache = new Map<string, Promise<string>>();

export function resetSelfSecretCache(): void {
  resolvedCache.clear();
}

function noticeOnce(name: string, message: string): void {
  if (envOnrampWarned.has(name)) return;
  envOnrampWarned.add(name);
  console.warn(message);
}

export function selfSecretsArmed(): boolean {
  return credentialKeyArmed();
}

export async function getOrMintSelfSecret(name: string, deps: SelfSecretDeps = {}): Promise<string> {
  if (!credentialKeyArmed()) {
    throw new CredentialError(
      `"${name}" is a self-shared secret (minted and held by this deployment for itself) but ${CREDENTIAL_KEY_ENV} is not set ` +
        `(or is not a base64-encoded 32-byte key) — refusing to read or mint it (fail closed). Set ${CREDENTIAL_KEY_ENV} to arm the ` +
        `credential store.`,
    );
  }
  if (!deps.vault) {
    const cached = resolvedCache.get(name);
    if (cached) return cached;
    const resolution = resolveOrMint(name, encryptedKvVault(), deps.env ?? process.env);
    const promise = resolution.then((result) => result.value);
    resolvedCache.set(name, promise);
    resolution.then(
      (result) => {
        if (result.mintedFresh && resolvedCache.get(name) === promise) resolvedCache.delete(name);
      },
      () => {
        if (resolvedCache.get(name) === promise) resolvedCache.delete(name);
      },
    );
    return promise;
  }
  const result = await resolveOrMint(name, deps.vault, deps.env ?? process.env);
  return result.value;
}

interface ResolvedSelfSecret {
  readonly value: string;
  readonly mintedFresh: boolean;
}

async function resolveOrMint(name: string, vault: EncryptedKvVault, env: NodeJS.ProcessEnv): Promise<ResolvedSelfSecret> {
  const ref = `${SELF_SECRET_REF_NAMESPACE}${name}`;

  return vault.withLock(ref, async () => {
    const stored = await vault.read(ref);
    if (stored !== null) return { value: stored, mintedFresh: false };

    const fromEnv = (env[name] ?? "").trim();
    if (fromEnv.length > 0) {
      noticeOnce(
        name,
        `[open-everywhere:credentials] self-shared secret "${name}" resolved from the environment — the encrypted vault is its ` +
          `default home. It will keep reading from the env var until you remove it (nothing here promotes it automatically).`,
      );
      return { value: fromEnv, mintedFresh: false };
    }

    const minted = randomBytes(32).toString("base64url");
    await vault.write(ref, minted, { createdBy: "host:auto-mint" });
    const confirmed = await vault.read(ref);
    return { value: confirmed ?? minted, mintedFresh: true };
  });
}
