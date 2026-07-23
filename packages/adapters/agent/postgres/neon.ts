import {
  registerPostgres,
  registerOperationalPostgres,
  initPostgresSchema,
  type PgClient,
  initOperationalSchema,
} from "@open-everywhere/core/agent/adapter-api.js";

export async function registerNeon(connectionString = process.env.DATABASE_URL): Promise<PgClient> {
  if (!connectionString) {
    throw new Error("registerNeon: no connection string (set DATABASE_URL)");
  }
  const pkg = "@neondatabase/serverless";
  const { Pool } = (await import(pkg)) as { Pool: new (cfg: { connectionString: string }) => unknown };
  const pool = new Pool({ connectionString }) as {
    query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
    on?(event: "error", listener: (err: unknown) => void): unknown;
  };
  attachPoolErrorHandler(pool);
  const client: PgClient = { query: (text, params) => pool.query(text, params) };

  await initPostgresSchema(client);
  await initOperationalSchema(client);
  registerPostgres(client);
  registerOperationalPostgres(client);
  return client;
}

export function attachPoolErrorHandler(pool: { on?(event: "error", listener: (err: unknown) => void): unknown }): void {
  pool.on?.("error", (err) => {
    console.warn(`[open-everywhere:neon] pool error on an idle connection (ignored, no query affected): ${err instanceof Error ? err.message : String(err)}`);
  });
}
