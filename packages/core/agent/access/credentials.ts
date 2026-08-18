import type { Connection, CredentialAuthorizationDetail, CredentialType, CustomHeader } from "./bundle.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export class CredentialError extends Error {}

export const CREDENTIAL_UNRESOLVED = "credential.unresolved";

export type UnresolvedReason = "no-stored-row" | "reserved-namespace" | "broker-unstamped" | "broker-not-registered";

export const UNSTAMPED_BROKER = "(unstamped)";

async function auditUnresolved(broker: string, ref: string, reason: UnresolvedReason): Promise<void> {
  await appendAudit({
    org: deploymentOrg(),
    platform: "credential",
    workspace: broker,
    action: CREDENTIAL_UNRESOLVED,
    detail: { broker, ref, reason },
  }).catch(() => undefined);
}

export interface BrokeredSecret {
  readonly value: string;
  readonly expiresAtMs?: number;
}

export interface CredentialBroker {
  getSecret(ref: string, authorizationDetails?: readonly CredentialAuthorizationDetail[]): Promise<string>;
  getSecretWithLifetime?(ref: string, authorizationDetails?: readonly CredentialAuthorizationDetail[]): Promise<BrokeredSecret>;
}

export const envBroker: CredentialBroker = {
  async getSecret(ref) {
    const v = process.env[ref];
    if (!v) throw new CredentialError(`secret not found for ref "${ref}" (set env ${ref})`);
    return v;
  },
};

export const ENV_BROKER = "env";

const BROKERS: Record<string, CredentialBroker> = Object.create(null) as Record<string, CredentialBroker>;

export function registerBroker(name: string, broker: CredentialBroker): void {
  BROKERS[name] = broker;
}

registerBroker(ENV_BROKER, envBroker);

export function resetBrokers(): void {
  for (const k of Object.keys(BROKERS)) delete BROKERS[k];
  registerBroker(ENV_BROKER, envBroker);
}

export function registeredBrokerNames(): readonly string[] {
  return Object.keys(BROKERS);
}

export function brokerFor(name: string): CredentialBroker {
  const broker = BROKERS[name];
  if (!broker) {
    throw new CredentialError(
      `credential home broker "${name}" is not registered — register it at startup ` +
        `(see @open-everywhere/adapters) or correct the credential's \`broker\` field. ` +
        `Refusing to fall back to another broker (fail closed).`,
    );
  }
  return broker;
}

export async function getSecretVia(
  broker: string | undefined,
  ref: string,
  authorizationDetails?: readonly CredentialAuthorizationDetail[],
): Promise<string> {
  return (await getSecretWithLifetimeVia(broker, ref, authorizationDetails)).value;
}

export async function getSecretWithLifetimeVia(
  broker: string | undefined,
  ref: string,
  authorizationDetails?: readonly CredentialAuthorizationDetail[],
): Promise<BrokeredSecret> {
  if (broker === undefined) {
    await auditUnresolved(UNSTAMPED_BROKER, ref, "broker-unstamped");
    throw new CredentialError(
      `no credential broker for ref "${ref}" — every credential must name its home broker ` +
        `(\`broker: "env" | "db" | ...\`); there is no selected default. Stamp the credential's broker.`,
    );
  }
  if (BROKERS[broker] === undefined) await auditUnresolved(broker, ref, "broker-not-registered");
  const resolved = brokerFor(broker);
  if (resolved.getSecretWithLifetime) return resolved.getSecretWithLifetime(ref, authorizationDetails);
  return { value: await resolved.getSecret(ref, authorizationDetails) };
}

async function resolveCustomHeaders(
  headers: readonly CustomHeader[] | undefined,
  broker?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) out[h.name] = `${h.prefix ?? ""}${await getSecretVia(broker, h.secretRef)}`;
  return out;
}

type Handler = (conn: Connection) => Promise<Record<string, string>>;

const HANDLERS: Record<CredentialType, Handler> = {
  bearer: async (conn) => ({
    authorization: `Bearer ${await getSecretVia(conn.broker, conn.secretRef, conn.authorizationDetails)}`,
    ...(await resolveCustomHeaders(conn.customHeaders, conn.broker)),
  }),
  basic: async (conn) => {
    const b64 = Buffer.from(await getSecretVia(conn.broker, conn.secretRef, conn.authorizationDetails), "utf-8").toString("base64");
    return { authorization: `Basic ${b64}`, ...(await resolveCustomHeaders(conn.customHeaders, conn.broker)) };
  },
  "github-app": async (conn) => ({
    authorization: `Bearer ${await getSecretVia(conn.broker, conn.secretRef, conn.authorizationDetails)}`,
    ...(await resolveCustomHeaders(conn.customHeaders, conn.broker)),
  }),
};

export async function resolveHeaders(conn: Connection): Promise<Record<string, string>> {
  return HANDLERS[conn.credentialType](conn);
}

export function isImplemented(type: CredentialType): boolean {
  return type in HANDLERS;
}
