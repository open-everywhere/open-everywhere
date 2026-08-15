export const DB_REF_PREFIX = "db:";

export function dbCredentialRef(connector: string, credentialId: string): string {
  if (!connector || !credentialId) {
    throw new Error(`dbCredentialRef needs a non-empty connector and credentialId (got "${connector}"/"${credentialId}")`);
  }
  if (connector.includes(":") || credentialId.includes(":")) {
    throw new Error(`dbCredentialRef: neither connector ("${connector}") nor credentialId ("${credentialId}") may contain ":" — it is the ref delimiter`);
  }
  return `${DB_REF_PREFIX}${connector}:${credentialId}`;
}

export function parseDbCredentialRef(ref: string): { connector: string; credentialId: string } | null {
  if (typeof ref !== "string" || !ref.startsWith(DB_REF_PREFIX)) return null;
  const rest = ref.slice(DB_REF_PREFIX.length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const connector = rest.slice(0, idx);
  const credentialId = rest.slice(idx + 1);
  if (!connector || !credentialId || credentialId.includes(":")) return null;
  return { connector, credentialId };
}

export interface CredentialRefDeriveInput {
  readonly connector: string;
  readonly credentialId: string;
}

export interface RefCodec {
  readonly home: string;
  parse(ref: string): Readonly<Record<string, string>> | null;
  derive?(input: CredentialRefDeriveInput): string | null;
}

export const DB_HOME = "db";

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
    derive: (input) => dbCredentialRef(input.connector, input.credentialId),
  });
}

registerCoreRefCodecs();
