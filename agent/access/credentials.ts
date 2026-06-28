import type { Connection, CredentialType, CustomHeader } from "./bundle.js";

export class CredentialError extends Error {}

export interface CredentialBroker {
  getSecret(ref: string): Promise<string>;
}

const envBroker: CredentialBroker = {
  async getSecret(ref) {
    const v = process.env[ref];
    if (!v) throw new CredentialError(`secret not found for ref "${ref}" (set env ${ref})`);
    return v;
  },
};

let warnedConnectFallback = false;
const vercelConnectBroker: CredentialBroker = {
  async getSecret(ref) {
    if (!warnedConnectFallback) {
      console.warn(
        `[open-everywhere:credentials] OE_CREDENTIAL_BROKER=vercel-connect but no live Connect binding — falling back to env. Wire @vercel/connect to enable.`,
      );
      warnedConnectFallback = true;
    }
    return envBroker.getSecret(ref);
  },
};

export function selectBroker(): CredentialBroker {
  const choice = process.env.OE_CREDENTIAL_BROKER;
  if (choice === "env") return envBroker;
  if (choice === "vercel-connect") return vercelConnectBroker;
  return process.env.VERCEL ? vercelConnectBroker : envBroker;
}

function getSecret(ref: string): Promise<string> {
  return selectBroker().getSecret(ref);
}

async function resolveCustomHeaders(
  headers: readonly CustomHeader[] | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) out[h.name] = `${h.prefix ?? ""}${await getSecret(h.secretRef)}`;
  return out;
}

type Handler = (conn: Connection) => Promise<Record<string, string>>;

const HANDLERS: Record<CredentialType, Handler> = {
  bearer: async (conn) => ({
    authorization: `Bearer ${await getSecret(conn.secretRef)}`,
    ...(await resolveCustomHeaders(conn.customHeaders)),
  }),
  basic: async (conn) => {
    const b64 = Buffer.from(await getSecret(conn.secretRef), "utf-8").toString("base64");
    return { authorization: `Basic ${b64}`, ...(await resolveCustomHeaders(conn.customHeaders)) };
  },
  "github-app": async (conn) => ({
    authorization: `Bearer ${await getSecret(conn.secretRef)}`,
    ...(await resolveCustomHeaders(conn.customHeaders)),
  }),
};

export async function resolveHeaders(conn: Connection): Promise<Record<string, string>> {
  return HANDLERS[conn.credentialType](conn);
}

export function isImplemented(type: CredentialType): boolean {
  return type in HANDLERS;
}
