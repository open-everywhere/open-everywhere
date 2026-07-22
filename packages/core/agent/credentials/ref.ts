export const DB_REF_PREFIX = "db:";

export function dbCredentialRef(provider: string, credentialId: string): string {
  if (!provider || !credentialId) {
    throw new Error(`dbCredentialRef needs a non-empty provider and credentialId (got "${provider}"/"${credentialId}")`);
  }
  if (provider.includes(":") || credentialId.includes(":")) {
    throw new Error(`dbCredentialRef: neither provider ("${provider}") nor credentialId ("${credentialId}") may contain ":" — it is the ref delimiter`);
  }
  return `${DB_REF_PREFIX}${provider}:${credentialId}`;
}

export function parseDbCredentialRef(ref: string): { provider: string; credentialId: string } | null {
  if (typeof ref !== "string" || !ref.startsWith(DB_REF_PREFIX)) return null;
  const rest = ref.slice(DB_REF_PREFIX.length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const provider = rest.slice(0, idx);
  const credentialId = rest.slice(idx + 1);
  if (!provider || !credentialId || credentialId.includes(":")) return null;
  return { provider, credentialId };
}

export const EXECUTOR_REF_PREFIX = "executor:";

export function executorCredentialRef(integration: string, owner: string, connection: string): string {
  if (!integration || !owner || !connection) {
    throw new Error(
      `executorCredentialRef needs non-empty integration/owner/connection (got "${integration}"/"${owner}"/"${connection}")`,
    );
  }
  if (integration.includes(":") || owner.includes(":") || connection.includes(":")) {
    throw new Error(
      `executorCredentialRef: no segment may contain ":" — it is the ref delimiter (got ` +
        `"${integration}"/"${owner}"/"${connection}")`,
    );
  }
  return `${EXECUTOR_REF_PREFIX}${integration}:${owner}:${connection}`;
}

export function parseExecutorCredentialRef(ref: string): { integration: string; owner: string; connection: string } | null {
  if (typeof ref !== "string" || !ref.startsWith(EXECUTOR_REF_PREFIX)) return null;
  const rest = ref.slice(EXECUTOR_REF_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) return null;
  const [integration, owner, connection] = parts;
  if (!integration || !owner || !connection) return null;
  return { integration, owner, connection };
}
