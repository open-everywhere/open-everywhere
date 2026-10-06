import { resolveMemoryProviderId } from "../memory/backing-selection.js";
import { isMemoryProviderRegistered } from "../memory/provider.js";
import { isOperationalStoreRegistered } from "./provider.js";
import { resolveOperationalSelection } from "./selection.js";

export interface PostgresRegistrations {
  readonly memory: boolean;
  readonly operational: boolean;
}

export function postgresWiringRefusal(env: NodeJS.ProcessEnv, registered: PostgresRegistrations): string | undefined {
  const operational = resolveOperationalSelection(env);
  const missing: string[] = [];
  if (operational.id === "postgres" && operational.floor === "none" && !registered.operational) missing.push("operational store");
  if (resolveMemoryProviderId(env) === "postgres" && !registered.memory) missing.push("memory backing");
  if (missing.length === 0) return undefined;
  const what = `the ${missing.join(" and the ")} ${missing.length > 1 ? "are" : "is"} Postgres`;
  if (!env.DATABASE_URL?.trim()) {
    return (
      `open-everywhere refuses to boot: an OE_*_PROVIDER variable selects Postgres, so ${what}, but DATABASE_URL is unset ` +
      "and no Postgres client is registered — set DATABASE_URL, or remove the selector that names postgres."
    );
  }
  return (
    `open-everywhere refuses to boot: DATABASE_URL is set, so ${what}, but no Postgres client is registered — ` +
    "the app's agent/lib/register-adapters.ts is most likely a stale copy from an older template that wires the adapters " +
    "by hand and does not call registerNeon() on DATABASE_URL alone, so sync it from the template of the installed " +
    "@open-everywhere/create, whose copy is one registerDefaultAdapters() call " +
    "(`npx oe upgrade --plan --to <installed version>` lists every stale template file)."
  );
}

export function assertPostgresWiredAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  const refusal = postgresWiringRefusal(env, {
    memory: isMemoryProviderRegistered("postgres"),
    operational: isOperationalStoreRegistered("postgres"),
  });
  if (refusal !== undefined) throw new Error(refusal);
}
