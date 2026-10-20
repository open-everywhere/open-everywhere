import { CredentialError } from "../access/credentials.js";
import { deploymentOrg } from "../identity/binding.js";
import { credentialKeyArmed, decryptCredential, storeDbSecret, CREDENTIAL_KEY_ENV } from "./db-broker.js";
import { getOperationalStore } from "../operational/provider.js";
import { reservedRefNamespace, reservedRefRefusal } from "./reserved-refs.js";
import { envFallbackValue } from "./operator-secret-env.js";

export { operatorSecretEnvFallbackPresent } from "./operator-secret-env.js";

export const SET_BY_CLI = "operator:cli";
export const SET_BY_OPS_MCP = "operator:ops-mcp";

export const SECRET_STORE_ENV_KEYS: readonly string[] = [
  "DATABASE_URL",
  "OE_CREDENTIAL_ENCRYPTION_KEY",
  "OE_OPERATIONAL_PROVIDER",
  "OE_PGLITE_DIR",
  "OE_SQLITE_PATH",
] as const;

export interface SecretWriteResult {
  readonly name: string;
  readonly bytes: number;
  readonly at: string;
  readonly replaced: boolean;
}

export interface SecretListEntry {
  readonly name: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly internal: boolean;
}

export interface OperatorSecretOptions {
  readonly org?: string;
}

const MAX_NAME_LENGTH = 200;

export function secretNameRefusal(name: string): string | undefined {
  if (typeof name !== "string" || name.length === 0) return "a secret name is required (the name a credential’s secretRef points at, e.g. ACME_API_TOKEN)";
  if (name.length > MAX_NAME_LENGTH) return `secret name is ${name.length} characters — the limit is ${MAX_NAME_LENGTH}`;
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.test(name)) {
    return `secret name ${JSON.stringify(name)} contains whitespace or a control/invisible character`;
  }
  const reserved = reservedRefNamespace(name);
  if (reserved) return reservedRefRefusal(name, reserved);
  return undefined;
}

export interface ParsedSecretEntry {
  readonly name: string;
  readonly value: string;
}

export interface ParsedSecretFile {
  readonly entries: readonly ParsedSecretEntry[];
  readonly errors: readonly string[];
}

export function parseSecretEnvFile(text: string): ParsedSecretFile {
  const entries: ParsedSecretEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      errors.push(`line ${lineNo}: not a KEY=VALUE line`);
      continue;
    }
    const name = body.slice(0, eq).trim();
    const refusal = secretNameRefusal(name);
    if (refusal) {
      errors.push(`line ${lineNo}: ${refusal}`);
      continue;
    }
    const value = unquoteEnvValue(body.slice(eq + 1).trim());
    if (value.length === 0) {
      errors.push(`line ${lineNo}: ${name} has an empty value — refusing (delete the line, or use \`oe secret rm ${name}\`)`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`line ${lineNo}: ${name} appears more than once — refusing rather than guessing which wins`);
      continue;
    }
    seen.add(name);
    entries.push({ name, value });
  }
  return { entries, errors };
}

function unquoteEnvValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return raw;
}

export interface SetOperatorSecretInput extends OperatorSecretOptions {
  readonly name: string;
  readonly value: string;
  readonly setBy: string;
  readonly at?: string;
}

export async function setOperatorSecret(input: SetOperatorSecretInput): Promise<SecretWriteResult> {
  const refusal = secretNameRefusal(input.name);
  if (refusal) throw new CredentialError(refusal);
  if (typeof input.value !== "string" || input.value.length === 0) {
    throw new CredentialError(`refusing to store an empty value for ${JSON.stringify(input.name)} (use \`oe secret rm\` to delete it)`);
  }
  requireArmedKey("store");

  const org = input.org ?? deploymentOrg();
  const at = input.at ?? new Date().toISOString();
  const existing = await getOperationalStore().getStoredCredential(org, input.name);
  await storeDbSecret({ org, ref: input.name, plaintext: input.value, createdBy: input.setBy, at });
  return { name: input.name, bytes: Buffer.byteLength(input.value, "utf8"), at, replaced: existing !== null };
}

export async function listOperatorSecrets(
  opts: OperatorSecretOptions & { readonly includeInternal?: boolean } = {},
): Promise<readonly SecretListEntry[]> {
  const org = opts.org ?? deploymentOrg();
  const store = getOperationalStore();
  const refs = await store.listStoredCredentialRefs(org);
  const out: SecretListEntry[] = [];
  for (const ref of refs) {
    const internal = reservedRefNamespace(ref) !== undefined;
    if (internal && !opts.includeInternal) continue;
    const row = await store.getStoredCredential(org, ref);
    if (!row) continue;
    out.push({ name: ref, setBy: row.createdBy, setAt: row.createdAt, internal });
  }
  return out;
}

export async function removeOperatorSecret(name: string, opts: OperatorSecretOptions = {}): Promise<boolean> {
  const refusal = secretNameRefusal(name);
  if (refusal) throw new CredentialError(refusal);
  return await getOperationalStore().deleteStoredCredential(opts.org ?? deploymentOrg(), name);
}

export type OperatorSecretSource = "db" | "env";

export interface ResolvedOperatorSecret {
  readonly value: string;
  readonly source: OperatorSecretSource;
}

export class OperatorSecretNotSetError extends CredentialError {}

let envFallbackWarned = new Set<string>();

export function resetOperatorSecretWarnings(): void {
  envFallbackWarned = new Set<string>();
}

export async function getOperatorSecret(name: string, opts: OperatorSecretOptions = {}): Promise<ResolvedOperatorSecret> {
  const reserved = reservedRefNamespace(name);
  if (reserved) throw new CredentialError(reservedRefRefusal(name, reserved));

  const org = opts.org ?? deploymentOrg();
  let row: { ciphertext: string } | null = null;
  try {
    row = await getOperationalStore().getStoredCredential(org, name);
  } catch (err) {
    noticeOnce(name, `[open-everywhere:credentials] secret "${name}": the operational store is unreachable (${String(err instanceof Error ? err.message : err)}) — falling back to the env var if set.`);
  }

  if (row) {
    if (!credentialKeyArmed()) {
      throw new CredentialError(
        `secret "${name}" is stored in the db credential store but ${CREDENTIAL_KEY_ENV} is not set (or is malformed) — refusing ` +
          `to fall back to the environment variable of the same name, which may be a retired value (fail closed). Set ` +
          `${CREDENTIAL_KEY_ENV} to the base64 32-byte key this deployment stored with.`,
      );
    }
    return { value: decryptCredential(row.ciphertext), source: "db" };
  }

  const fromEnv = envFallbackValue(name, process.env);
  if (fromEnv !== undefined) {
    noticeOnce(
      name,
      `[open-everywhere:credentials] secret "${name}" resolved from the environment — the db credential store is its default home. ` +
        `Move it with \`oe secret set ${name}\` (then the env var can be deleted).`,
    );
    return { value: fromEnv, source: "env" };
  }

  throw new OperatorSecretNotSetError(
    `secret "${name}" is not set: no row in the db credential store for org "${org}", and no environment variable of that name. ` +
      `Store it with \`oe secret set ${name}\` (value on stdin).`,
  );
}

const OPERATOR_SECRET_TTL_MS = 30_000;

const OPERATOR_SECRET_FAULT_BACKOFF_MS = 5_000;

const storedRowMemo = new Map<string, { readonly row: { ciphertext: string } | null; readonly until: number }>();

export function resetOperatorSecretMemo(): void {
  storedRowMemo.clear();
  softFaultReported.clear();
}

export async function operatorSecret(
  name: string,
  opts: OperatorSecretOptions & {
    readonly now?: () => number;
    readonly store?: { getStoredCredential(org: string, ref: string): Promise<{ ciphertext: string } | null> };
  } = {},
): Promise<string | undefined> {
  const reserved = reservedRefNamespace(name);
  if (reserved) throw new CredentialError(reservedRefRefusal(name, reserved));

  const org = opts.org ?? deploymentOrg();
  const now = (opts.now ?? Date.now)();
  const key = `${org}\u0000${name}`;
  const cached = storedRowMemo.get(key);
  let row: { ciphertext: string } | null;
  if (cached !== undefined && cached.until > now) {
    row = cached.row;
  } else {
    row = null;
    let ttl = OPERATOR_SECRET_TTL_MS;
    try {
      row = await (opts.store ?? getOperationalStore()).getStoredCredential(org, name);
    } catch (err) {
      noticeOnce(name, `[open-everywhere:credentials] secret "${name}": the operational store is unreachable (${String(err instanceof Error ? err.message : err)}) — falling back to the env var if set.`);
      ttl = OPERATOR_SECRET_FAULT_BACKOFF_MS;
    }
    storedRowMemo.set(key, { row, until: now + ttl });
  }

  if (row) {
    if (!credentialKeyArmed()) {
      throw new CredentialError(
        `secret "${name}" is stored in the db credential store but ${CREDENTIAL_KEY_ENV} is not set (or is malformed) — refusing ` +
          `to fall back to the environment variable of the same name, which may be a retired value (fail closed).`,
      );
    }
    return decryptCredential(row.ciphertext);
  }

  const fromEnv = envFallbackValue(name, process.env);
  if (fromEnv !== undefined) {
    noticeOnce(
      name,
      `[open-everywhere:credentials] secret "${name}" resolved from the environment — the db credential store is its default home. ` +
        `Move it with \`oe secret set ${name}\` (then the env var can be deleted).`,
    );
    return fromEnv;
  }
  return undefined;
}

const softFaultReported = new Set<string>();

export async function operatorSecretOrUnset(name: string, opts: OperatorSecretOptions = {}): Promise<string | undefined> {
  try {
    return await operatorSecret(name, opts);
  } catch (err) {
    if (!softFaultReported.has(name)) {
      softFaultReported.add(name);
      console.warn(`[open-everywhere:credentials] secret "${name}" did not resolve, so it reads as unset: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
}

export async function operatorSecretConfigured(name: string, opts: OperatorSecretOptions = {}): Promise<boolean> {
  try {
    return (await operatorSecret(name, opts)) !== undefined;
  } catch {
    return false;
  }
}

function noticeOnce(name: string, message: string): void {
  if (envFallbackWarned.has(name)) return;
  envFallbackWarned.add(name);
  console.warn(message);
}

function requireArmedKey(what: "store"): void {
  if (credentialKeyArmed()) return;
  throw new CredentialError(
    `${CREDENTIAL_KEY_ENV} is not set (or is not a base64-encoded 32-byte key) — refusing to ${what} a secret (fail closed). ` +
      `It is one of this deployment's root-of-trust variables: set the SAME value the deployed instance holds, or nothing ` +
      `written here will be readable there. Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
  );
}
