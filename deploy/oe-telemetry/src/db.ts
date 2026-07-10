import { neon, Pool, type NeonQueryFunction } from "@neondatabase/serverless";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

let cachedSql: NeonQueryFunction<false, false> | undefined;

export function sql(): NeonQueryFunction<false, false> {
  if (!cachedSql) cachedSql = neon<false, false>(requireDatabaseUrl());
  return cachedSql;
}

export function getPool(): Pool {
  return new Pool({ connectionString: requireDatabaseUrl() });
}

export function __resetDbForTest(): void {
  cachedSql = undefined;
}
