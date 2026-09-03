import { existsSync, readFileSync } from "node:fs";
import { SECRET_STORE_ENV_KEYS } from "../agent/credentials/operator-secrets.js";
import { registerOperationalPgliteLazy } from "../agent/operational/pglite-client.js";
import { initOperationalSchema, type PgClient } from "../agent/operational/postgres.js";
import {
  registerOperationalPostgres,
  requireArmedOperationalFloor,
  resetOperationalStore,
  resolveOperationalSelection,
} from "../agent/operational/provider.js";

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

export async function connectOperatorStore(): Promise<OperatorStoreTarget> {
  if (connected) return connected;
  const selection = resolveOperationalSelection();

  if (selection.floor === "pglite") {
    registerOperationalPgliteLazy();
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
          "(put it in .env.local, or pass --env-file).",
      );
    }
    const client = await neonClient(url);
    await initOperationalSchema(client);
    registerOperationalPostgres(client);
    resetOperationalStore();
    connected = { id: "postgres", label: "hosted Postgres (DATABASE_URL)" };
    return connected;
  }

  connected = { id: selection.id, label: "sqlite file (DEPRECATED floor — see docs/deploy/database-graduation.md)" };
  return connected;
}

export function resetOperatorStoreConnection(): void {
  connected = null;
  requireArmedOperationalFloor(false);
}

async function neonClient(connectionString: string): Promise<PgClient> {
  const pkg = "@neondatabase/serverless";
  let Pool: new (cfg: { connectionString: string }) => { query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> };
  try {
    ({ Pool } = (await import(pkg)) as {
      Pool: new (cfg: { connectionString: string }) => { query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> };
    });
  } catch (err) {
    throw new Error(
      `cannot open hosted Postgres: the ${pkg} driver is not installed in this checkout (${String(err instanceof Error ? err.message : err)}). ` +
        "Run the secret commands from the Open Everywhere repo root after `npm install`.",
    );
  }
  const pool = new Pool({ connectionString });
  return { query: (text, params) => pool.query(text, params) };
}
