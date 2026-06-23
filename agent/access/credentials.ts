import type { Connection, CredentialType } from "./bundle.js";

export class CredentialError extends Error {}

function getSecret(ref: string): string {
  const v = process.env[ref];
  if (!v) throw new CredentialError(`secret not found for ref "${ref}" (set env ${ref})`);
  return v;
}

type Handler = (conn: Connection) => Promise<Record<string, string>>;

const notImplemented =
  (type: CredentialType): Handler =>
  async () => {
    throw new CredentialError(
      `credential type "${type}" needs a token-exchange handler not yet implemented (Phase 2 next slice)`,
    );
  };

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

  "body-parameter": notImplemented("body-parameter"),
  "aws-sigv4": notImplemented("aws-sigv4"),
  "gcp-access-token": notImplemented("gcp-access-token"),
  "gcp-iap": notImplemented("gcp-iap"),
  "oauth2-jwt-bearer": notImplemented("oauth2-jwt-bearer"),
  "oauth2-client-credentials": notImplemented("oauth2-client-credentials"),
  "oauth2-authorization-code": notImplemented("oauth2-authorization-code"),
};

export async function resolveHeaders(conn: Connection): Promise<Record<string, string>> {
  return HANDLERS[conn.credentialType](conn);
}

export function isImplemented(type: CredentialType): boolean {
  return ["bearer", "basic", "github-app"].includes(type);
}
