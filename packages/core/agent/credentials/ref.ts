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
