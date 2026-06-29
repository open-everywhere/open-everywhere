import {
  registerPostgres,
} from "@open-everywhere/core/agent/memory/provider.js";
import {
  registerOperationalPostgres,
} from "@open-everywhere/core/agent/operational/provider.js";
import {
  initPostgresSchema,
  type PgClient,
} from "@open-everywhere/core/agent/memory/postgres.js";
import {
  initOperationalSchema,
} from "@open-everywhere/core/agent/operational/postgres.js";

export async function registerNeon(connectionString = process.env.DATABASE_URL): Promise<PgClient> {
  if (!connectionString) {
    throw new Error("registerNeon: no connection string (set DATABASE_URL)");
  }
  const pkg = "@neondatabase/serverless";
  const { Pool } = (await import(pkg)) as { Pool: new (cfg: { connectionString: string }) => unknown };
  const pool = new Pool({ connectionString }) as {
    query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  };
  const client: PgClient = { query: (text, params) => pool.query(text, params) };

  await initPostgresSchema(client);
  await initOperationalSchema(client);
  registerPostgres(client);
  registerOperationalPostgres(client);
  return client;
}
