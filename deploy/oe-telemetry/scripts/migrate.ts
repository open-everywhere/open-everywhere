import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

async function main(): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("[migrate] no migration files found in", migrationsDir);
    return;
  }

  const pool = getPool();
  try {
    for (const file of files) {
      const text = readFileSync(join(migrationsDir, file), "utf8");
      console.log(`[migrate] applying ${file}...`);
      await pool.query(text);
      console.log(`[migrate] ${file} OK`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
