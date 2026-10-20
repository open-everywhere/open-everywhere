import { CredentialError } from "../access/credentials.js";
import { orgWideWhere } from "../approvals/actions.js";
import { appendAudit } from "../audit/audit.js";
import { auditErrorDetail } from "../audit/tool-action.js";
import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg } from "../identity/binding.js";
import { isOperatorSecretName } from "../ops/operator-secret-roster.js";
import { envFallbackValue } from "./operator-secret-env.js";
import { SECRET_STORE_ENV_KEYS, secretNameRefusal, setOperatorSecret } from "./operator-secrets.js";

const SET_BY_ENV_ADOPT = "operator:env-adopt";

export const ENV_ADOPT_MAX_NAMES = 64;

export type EnvAdoptOutcome =
  | "stored"
  | "already-stored"
  | "no-env-value";

export interface EnvAdoptResult {
  readonly name: string;
  readonly outcome: EnvAdoptOutcome;
  readonly replaced?: boolean;
}

function envAdoptRefusal(names: readonly string[]): string | undefined {
  if (names.length === 0) return "name at least one operator secret to adopt.";
  if (names.length > ENV_ADOPT_MAX_NAMES) return `${names.length} names — the limit is ${ENV_ADOPT_MAX_NAMES} per call.`;
  const seen = new Set<string>();
  for (const [i, name] of names.entries()) {
    if (seen.has(name)) return `names[${i}] repeats an earlier name.`;
    seen.add(name);
    if (secretNameRefusal(name) !== undefined) return `names[${i}] is not a usable secret name.`;
    if (SECRET_STORE_ENV_KEYS.includes(name)) {
      return `names[${i}] is a root-of-trust variable (it opens the credential store), so it stays in the environment and is never adopted.`;
    }
    if (!isOperatorSecretName(name)) {
      return `names[${i}] is not an operator secret this deployment knows. Only a name on the operator-secret roster can be adopted.`;
    }
  }
  return undefined;
}

class EnvAdoptFault extends CredentialError {
  constructor(
    message: string,
    readonly results: readonly EnvAdoptResult[],
  ) {
    super(message);
  }
}

export interface AdoptEnvSecretsInput {
  readonly names: readonly string[];
  readonly overwrite?: boolean;
  readonly setBy: string;
  readonly org?: string;
  readonly env?: NodeJS.ProcessEnv;
}

async function adoptEnvOperatorSecrets(input: AdoptEnvSecretsInput): Promise<readonly EnvAdoptResult[]> {
  const refusal = envAdoptRefusal(input.names);
  if (refusal) throw new CredentialError(refusal);
  const org = input.org ?? deploymentOrg();
  const env = input.env ?? process.env;
  const results: EnvAdoptResult[] = [];
  for (const name of input.names) {
    const value = envFallbackValue(name, env);
    try {
      const existing = await getOperationalStore().getStoredCredential(org, name);
      if (existing !== null && input.overwrite !== true) {
        results.push({ name, outcome: "already-stored" });
        continue;
      }
      if (value === undefined) {
        results.push({ name, outcome: "no-env-value" });
        continue;
      }
      const written = await setOperatorSecret({ name, value, setBy: input.setBy, org });
      results.push({ name, outcome: "stored", replaced: written.replaced });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = value === undefined ? raw : withoutValue(raw, value);
      const landed = results.filter((r) => r.outcome === "stored").map((r) => r.name);
      throw new EnvAdoptFault(`adopting ${name} failed: ${message} (stored before the fault: ${landed.length > 0 ? landed.join(", ") : "none"})`, results);
    }
  }
  return results;
}

function withoutValue(text: string, value: string): string {
  return text.split(value).join("[redacted]");
}

export type EnvAdoptDoorOutcome =
  | { readonly ok: true; readonly results: readonly EnvAdoptResult[] }
  | { readonly ok: false; readonly refused: true; readonly message: string }
  | { readonly ok: false; readonly refused: false; readonly message: string };

export async function runEnvAdoptDoor(input: {
  readonly names: readonly string[];
  readonly overwrite: boolean;
  readonly actor: string;
  readonly org: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<EnvAdoptDoorOutcome> {
  const auditResults = (results: readonly EnvAdoptResult[], fault?: unknown) =>
    appendAudit({
      ...orgWideWhere(input.org),
      principalId: input.actor,
      action: "admin.secret.adopt_env",
      detail: {
        results: Object.fromEntries(results.map((r) => [r.name, r.outcome])),
        overwrite: input.overwrite,
        ...(fault === undefined ? {} : auditErrorDetail(fault)),
      },
    });
  let results: readonly EnvAdoptResult[];
  try {
    results = await adoptEnvOperatorSecrets({
      names: input.names,
      overwrite: input.overwrite,
      setBy: `${SET_BY_ENV_ADOPT}:${input.actor}`,
      org: input.org,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof EnvAdoptFault) {
      await auditResults(e.results, e);
      return { ok: false, refused: false, message };
    }
    return { ok: false, refused: e instanceof CredentialError, message };
  }
  await auditResults(results);
  return { ok: true, results };
}
