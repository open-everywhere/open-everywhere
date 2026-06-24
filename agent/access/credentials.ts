import type { Connection, CredentialType } from "./bundle.js";

export class CredentialError extends Error {}

function getSecret(ref: string): string {
  const v = process.env[ref];
  if (!v) throw new CredentialError(`secret not found for ref "${ref}" (set env ${ref})`);
  return v;
}

type Handler = (conn: Connection) => Promise<Record<string, string>>;

const HANDLERS: Record<CredentialType, Handler> = {
  bearer: async (conn) => ({
    authorization: `Bearer ${getSecret(conn.secretRef)}`,
    ...(conn.customHeaders ?? {}),
  }),
  basic: async (conn) => {
    const b64 = Buffer.from(getSecret(conn.secretRef), "utf-8").toString("base64");
    return { authorization: `Basic ${b64}` };
  },
  "github-app": async (conn) => ({ authorization: `Bearer ${getSecret(conn.secretRef)}` }),
};

export async function resolveHeaders(conn: Connection): Promise<Record<string, string>> {
  return HANDLERS[conn.credentialType](conn);
}

export function isImplemented(type: CredentialType): boolean {
  return type in HANDLERS;
}
