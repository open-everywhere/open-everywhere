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

const BROKERS: Record<string, CredentialBroker> = { env: envBroker };

export function registerBroker(name: string, broker: CredentialBroker): void {
  BROKERS[name] = broker;
}

export function resetBrokers(): void {
  for (const k of Object.keys(BROKERS)) if (k !== "env") delete BROKERS[k];
}

let warnedMissingBroker = false;

export function selectBroker(): CredentialBroker {
  const choice = process.env.OE_CREDENTIAL_BROKER ?? (process.env.VERCEL ? "vercel-connect" : "env");
  const broker = BROKERS[choice];
  if (broker) return broker;
  if (!warnedMissingBroker) {
    console.warn(
      `[open-everywhere:credentials] credential broker "${choice}" not registered — falling back to env. ` +
        `Register it at startup (see @open-everywhere/adapters).`,
    );
    warnedMissingBroker = true;
  }
  return envBroker;
}

export function getSecret(ref: string): Promise<string> {
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
