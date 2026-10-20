import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CREDENTIAL_KEY_ENV, registerDbCredentialBroker } from "../agent/credentials/db-broker.js";
import { SECRET_STORE_ENV_KEYS } from "../agent/credentials/operator-secrets.js";
import { importAppModule, resolveAppRoot } from "../agent/scaffold/app-root.js";
import { registerSettings, type AgentSettingsOverrides } from "../agent/settings/settings.js";
import { registerDeploymentIdentity } from "../agent/identity/deployment-identity.js";
import { registerOperationalPgliteLazy } from "../agent/operational/pglite-client.js";
import { initOperationalSchema, type PgClient } from "../agent/operational/postgres.js";
import { gitProvider, registerPostgres, resolveMemoryProviderId, type MemoryProvider } from "../agent/memory/provider.js";
import { sqliteProvider } from "../agent/memory/sqlite.js";
import {
  registerOperationalPostgres,
  requireArmedOperationalFloor,
  resetOperationalStore,
  resolveOperationalSelection,
} from "../agent/operational/provider.js";

export interface OperatorStoreOpts {
  readonly readOnly?: boolean;
}

export interface OperatorStoreTarget {
  readonly id: string;
  readonly label: string;
}

let connected: OperatorStoreTarget | null = null;

export function loadRootOfTrustEnv(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  const applied: string[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    if (!SECRET_STORE_ENV_KEYS.includes(name)) continue;
    if (process.env[name] !== undefined && process.env[name] !== "") continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
    applied.push(name);
  }
  return applied;
}

export async function connectOperatorStore(opts: OperatorStoreOpts = {}): Promise<OperatorStoreTarget> {
  if (connected) return connected;
  const selection = resolveOperationalSelection();

  if (selection.floor === "pglite") {
    registerOperationalPgliteLazy(undefined, undefined, { readOnly: opts.readOnly === true });
    resetOperationalStore();
    requireArmedOperationalFloor();
    connected = { id: "postgres", label: "embedded Postgres floor (PGlite, local data dir)" };
    return connected;
  }

  if (selection.id === "postgres") {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error(
        'OE_OPERATIONAL_PROVIDER="postgres" but DATABASE_URL is not set — the operator-side secret commands open the ' +
          "deployment's own store directly, so they need the same connection string the deployment holds " +
          "(put it in .env.local, or pass --root-env PATH).",
      );
    }
    const client = await neonClient(url);
    if (!opts.readOnly) await initOperationalSchema(client);
    registerOperationalPostgres(client);
    resetOperationalStore();
    connected = { id: "postgres", label: "hosted Postgres (DATABASE_URL)" };
    return connected;
  }

  connected = { id: selection.id, label: "sqlite file (DEPRECATED floor — see docs/deploy/database-graduation.md)" };
  return connected;
}

export async function connectOperatorStoreForCli(argv: readonly string[] = process.argv, opts: OperatorStoreOpts = {}): Promise<OperatorStoreTarget> {
  const flag = argv.indexOf("--root-env");
  loadRootOfTrustEnv(resolve(flag >= 0 ? (argv[flag + 1] ?? ".env.local") : ".env.local"));
  const orgFlag = argv.indexOf("--org");
  declareOperatorOrg(orgFlag >= 0 ? argv[orgFlag + 1] : undefined);
  return await connectOperatorStore(opts);
}

export function declareOperatorOrg(org: string | undefined): void {
  if (org === undefined || org.trim().length === 0 || org.startsWith("-")) return;
  registerDeploymentIdentity({ org });
}

export async function connectOperatorMemory(): Promise<{ readonly providers: readonly MemoryProvider[]; readonly label: string }> {
  const id = resolveMemoryProviderId();
  if (id === "postgres") {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error("the memory backing is postgres but DATABASE_URL is not set — put it in .env.local, or pass --root-env PATH.");
    return { providers: [registerPostgres(await neonClient(url))], label: "hosted Postgres (DATABASE_URL)" };
  }
  if (id === "git") return { providers: [gitProvider, sqliteProvider], label: "git working tree + the local sqlite file (DM memory)" };
  if (id === "sqlite") return { providers: [sqliteProvider], label: "local sqlite file" };
  return { providers: [], label: `the ${id} backing, which keeps its files in your own workspace` };
}

export const OPERATOR_BOX_BACKENDS = ["vercel", "docker"] as const;
export type OperatorBoxBackend = (typeof OPERATOR_BOX_BACKENDS)[number];

export interface OperatorHoldersTarget {
  readonly purgeHooks: readonly string[];
  readonly boxBackend: OperatorBoxBackend | undefined;
}

export async function connectOperatorHolders(boxBackend: OperatorBoxBackend | undefined): Promise<OperatorHoldersTarget> {
  type Mod = { registerOperatorHolders(opts: { boxBackend?: OperatorBoxBackend }): OperatorHoldersTarget };
  const mod = await importAdaptersModule<Mod>(
    "operator-holders.js",
    "cannot load the credential-purge hooks and the box backend",
    "Run `oe erase` from the app's root, after `npm install`.",
  );
  return mod.registerOperatorHolders(boxBackend === undefined ? {} : { boxBackend });
}

type AdaptersReach = "operator-holders.js" | "directory/register.js";

async function importAdaptersModule<T>(subpath: AdaptersReach, what: string, hint: string): Promise<T> {
  const pkg = "@open-everywhere/adapters/agent/" + subpath;
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    throw new Error(
      `${what}: @open-everywhere/adapters is not installed where this runs (${String(err instanceof Error ? err.message : err)}). ${hint}`,
    );
  }
}

export interface OperatorDirectoryTarget {
  readonly provider: string | null;
  readonly selector: string;
}

export async function connectOperatorDirectory(env: NodeJS.ProcessEnv = process.env): Promise<OperatorDirectoryTarget> {
  const selector = (env.OE_DIRECTORY_PROVIDER ?? "").trim();
  if (selector === "") return { provider: null, selector };
  let overrides: AgentSettingsOverrides | undefined;
  try {
    ({ SETTINGS_OVERRIDES: overrides } = await importAppModule<{ SETTINGS_OVERRIDES?: AgentSettingsOverrides }>(
      "agent/settings/settings.ts",
      resolveAppRoot({ env }),
    ));
  } catch (err) {
    throw new Error(
      `OE_DIRECTORY_PROVIDER is set, but the app's agent/settings/settings.ts did not load (${String(err instanceof Error ? err.message : err)}). ` +
        "The directory verbs need the app's own directory.mode and directory.groupAllowlist, so the adapter is not armed on the shipped defaults. " +
        "Run from inside the app, or set OE_APP_ROOT to its absolute path.",
    );
  }
  if (typeof overrides !== "object" || overrides === null) {
    throw new Error(
      "OE_DIRECTORY_PROVIDER is set, but the app's agent/settings/settings.ts loaded and exports no SETTINGS_OVERRIDES object. " +
        "The directory verbs need the app's own directory.mode and directory.groupAllowlist, so the adapter is not armed on the shipped defaults.",
    );
  }
  registerSettings(overrides);
  if (env[CREDENTIAL_KEY_ENV]) registerDbCredentialBroker();
  const mod = await importAdaptersModule<{ registerDirectoryAdapter(): string | null }>(
    "directory/register.js",
    "cannot load the directory adapter",
    "Run the control entry from the app's root, after `npm install`.",
  );
  return { provider: mod.registerDirectoryAdapter(), selector };
}

export function resetOperatorStoreConnection(): void {
  connected = null;
  requireArmedOperationalFloor(false);
}

async function neonClient(connectionString: string): Promise<PgClient> {
  const pkg = "@neondatabase/serverless";
  type Conn = { query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>; release(err?: unknown): void };
  type NeonPool = new (cfg: { connectionString: string }) => {
    query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
    connect(): Promise<Conn>;
  };
  let Pool: NeonPool;
  try {
    ({ Pool } = (await import(pkg)) as { Pool: NeonPool });
  } catch (err) {
    throw new Error(
      `cannot open hosted Postgres: the ${pkg} driver is not installed in this checkout (${String(err instanceof Error ? err.message : err)}). ` +
        "Run the secret commands from the Open Everywhere repo root after `npm install`.",
    );
  }
  const pool = new Pool({ connectionString });
  return {
    query: (text, params) => pool.query(text, params),
    withConnection: async (fn) => {
      const conn = await pool.connect();
      try {
        const result = await fn({ query: (text, params) => conn.query(text, params) });
        conn.release();
        return result;
      } catch (err) {
        conn.release(err);
        throw err;
      }
    },
  };
}
