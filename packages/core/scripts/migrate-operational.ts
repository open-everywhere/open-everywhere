import { DatabaseSync } from "node:sqlite";
import { sqliteOperationalDbPath } from "../agent/operational/sqlite.js";
import type { PgClient } from "../agent/operational/postgres.js";
import { openOperationalPglite } from "../agent/operational/pglite-client.js";
import { migrateOperational } from "./migrate-operational-lib.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function targetClient(dbUrl: string): Promise<PgClient> {
  const pkg = "@neondatabase/serverless";
  const { Pool } = (await import(pkg)) as {
    Pool: new (cfg: { connectionString: string }) => { query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> };
  };
  const pool = new Pool({ connectionString: dbUrl });
  return { query: (text, params) => pool.query(text, params) };
}

async function main(): Promise<void> {
  const pgliteDir = arg("pglite-dir");
  const dbUrl = process.env.DATABASE_URL;
  if (!pgliteDir && !dbUrl) {
    console.error("Provide a target: DATABASE_URL (hosted Postgres) or --pglite-dir <dir> (embedded-Postgres floor).");
    process.exit(1);
  }
  const sourcePath = arg("source") ?? sqliteOperationalDbPath();
  const forceEmptyCheckOff = flag("force-empty-check-off");
  const memoryProvider = arg("memory-provider") ?? "git";
  const targetLabel = pgliteDir ? `embedded-Postgres (pglite): ${pgliteDir}` : "hosted Postgres (DATABASE_URL)";

  console.log("=== migrate-operational (sqlite → postgres) ===");
  console.log(`source sqlite:   ${sourcePath}`);
  console.log(`target:          ${targetLabel}`);
  console.log(`memory provider: ${memoryProvider}`);
  console.log(`empty-check:     ${forceEmptyCheckOff ? "OFF (--force-empty-check-off)" : "ON (refuse a non-empty target)"}`);
  console.log("");

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const pglite = pgliteDir ? await openOperationalPglite(pgliteDir) : null;
  const target: PgClient = pglite ? pglite.client : await targetClient(dbUrl as string);
  try {
    const report = await migrateOperational({ source, target, forceEmptyCheckOff, memoryProvider, log: (m) => console.log(m) });
    const opRows = report.tables.reduce((n, t) => n + t.target, 0);
    const memRows = (report.memory.tables ?? []).reduce((n, t) => n + t.target, 0);
    console.log("");
    console.log(`✓ migration complete: ${opRows} operational row(s) across ${report.tables.length} table(s); ${report.chainOrgs} audit chain(s) verified; memory — ${report.memory.status}${report.memory.tables ? ` (${memRows} row(s))` : ""}.`);
  } finally {
    source.close();
    if (pglite) await pglite.close();
  }
}

main().catch((e) => {
  console.error("MIGRATION FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
