import type { Connection, CredentialAuthorizationDetail, CredentialType, CustomHeader } from "./bundle.js";

export class CredentialError extends Error {}

export interface CredentialBroker {
  getSecret(ref: string, authorizationDetails?: readonly CredentialAuthorizationDetail[]): Promise<string>;
}

export const envBroker: CredentialBroker = {
  async getSecret(ref) {
    const v = process.env[ref];
    if (!v) throw new CredentialError(`secret not found for ref "${ref}" (set env ${ref})`);
    return v;
  },
};

export const DEFAULT_BROKER = "env";

const BROKERS: Record<string, CredentialBroker> = {};

export function registerBroker(name: string, broker: CredentialBroker): void {
  BROKERS[name] = broker;
}

registerBroker(DEFAULT_BROKER, envBroker);

export function resetBrokers(): void {
  for (const k of Object.keys(BROKERS)) delete BROKERS[k];
  registerBroker(DEFAULT_BROKER, envBroker);
}

export function activeBrokerName(): string {
  return process.env.OE_CREDENTIAL_BROKER ?? (process.env.VERCEL ? "vercel-connect" : DEFAULT_BROKER);
}

export function selectBroker(): CredentialBroker {
  const choice = process.env.OE_CREDENTIAL_BROKER ?? (process.env.VERCEL ? "vercel-connect" : DEFAULT_BROKER);
  const broker = BROKERS[choice];
  if (!broker) {
    throw new CredentialError(
      `credential broker "${choice}" is not registered — register it at startup ` +
        `(see @open-everywhere/adapters) or set OE_CREDENTIAL_BROKER to a registered broker. ` +
        `Refusing to fall back to another broker (fail closed).`,
    );
  }
  return broker;
}

export function getSecret(ref: string, authorizationDetails?: readonly CredentialAuthorizationDetail[]): Promise<string> {
  return selectBroker().getSecret(ref, authorizationDetails);
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
    authorization: `Bearer ${await getSecret(conn.secretRef, conn.authorizationDetails)}`,
    ...(await resolveCustomHeaders(conn.customHeaders)),
  }),
  basic: async (conn) => {
    const b64 = Buffer.from(await getSecret(conn.secretRef, conn.authorizationDetails), "utf-8").toString("base64");
    return { authorization: `Basic ${b64}`, ...(await resolveCustomHeaders(conn.customHeaders)) };
  },
  "github-app": async (conn) => ({
    authorization: `Bearer ${await getSecret(conn.secretRef, conn.authorizationDetails)}`,
    ...(await resolveCustomHeaders(conn.customHeaders)),
  }),
};

export async function resolveHeaders(conn: Connection): Promise<Record<string, string>> {
  return HANDLERS[conn.credentialType](conn);
}

export function isImplemented(type: CredentialType): boolean {
  return type in HANDLERS;
}
