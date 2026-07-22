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

export interface CredentialRefDeriveInput {
  readonly provider: string;
  readonly credentialId: string;
  readonly executor?: { readonly integration: string; readonly owner: string; readonly connection: string };
}

export interface RefCodec {
  readonly home: string;
  parse(ref: string): Readonly<Record<string, string>> | null;
  derive?(input: CredentialRefDeriveInput): string | null;
}

export const DB_HOME = "db";
export const EXECUTOR_HOME = "executor";

const REF_CODECS = new Map<string, RefCodec>();

export function registerRefCodec(codec: RefCodec): void {
  REF_CODECS.set(codec.home, codec);
}

export function resetRefCodecs(): void {
  REF_CODECS.clear();
  registerCoreRefCodecs();
}

export type ParsedCredentialRef = { readonly home: string } & Readonly<Record<string, string>>;

export function parseCredentialRef(ref: string): ParsedCredentialRef | null {
  if (typeof ref !== "string") return null;
  for (const codec of REF_CODECS.values()) {
    const fields = codec.parse(ref);
    if (fields) return { home: codec.home, ...fields };
  }
  return null;
}

export function deriveCredentialRef(input: CredentialRefDeriveInput): string | null {
  for (const codec of REF_CODECS.values()) {
    const ref = codec.derive?.(input);
    if (ref !== null && ref !== undefined) return ref;
  }
  return null;
}

function registerCoreRefCodecs(): void {
  registerRefCodec({
    home: DB_HOME,
    parse: parseDbCredentialRef,
    derive: (input) => (input.executor ? null : dbCredentialRef(input.provider, input.credentialId)),
  });
  registerRefCodec({
    home: EXECUTOR_HOME,
    parse: parseExecutorCredentialRef,
    derive: (input) =>
      input.executor
        ? executorCredentialRef(input.executor.integration, input.executor.owner, input.executor.connection)
        : null,
  });
}

registerCoreRefCodecs();
