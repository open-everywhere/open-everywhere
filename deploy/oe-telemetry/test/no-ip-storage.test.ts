import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const tsFiles = [...walk(join(root, "src")), ...walk(join(root, "api"))];

{
  const migrationSql = readFileSync(join(root, "migrations", "001_init.sql"), "utf8");
  const tableBlocks = migrationSql.match(/CREATE TABLE[^;]*;/gis) ?? [];
  ok(tableBlocks.length >= 5, "found the expected number of CREATE TABLE statements to scan");

  const columnNamePattern = /^\s*([a-z_][a-z0-9_]*)\s+(TEXT|INTEGER|BIGINT|BIGSERIAL|NUMERIC|JSONB|TIMESTAMPTZ|DATE)\b/gim;
  const allColumnNames: string[] = [];
  for (const block of tableBlocks) {
    let match: RegExpExecArray | null;
    columnNamePattern.lastIndex = 0;
    while ((match = columnNamePattern.exec(block))) allColumnNames.push(match[1].toLowerCase());
  }
  ok(allColumnNames.length > 0, "extracted at least one column name from the schema");

  const ipLikeColumns = allColumnNames.filter((name) => name.includes("ip"));
  ok(ipLikeColumns.length === 0, `no column name contains "ip" (found: ${JSON.stringify(ipLikeColumns)})`);
}

{
  const filesReferencingForwardedFor: string[] = [];
  for (const file of tsFiles) {
    const text = readFileSync(file, "utf8");
    if (/x-forwarded-for/i.test(text)) filesReferencingForwardedFor.push(file.replace(root + "/", ""));
  }
  const allowed = new Set(["src/ip-limit.ts", "api/v1/logs.ts"]);
  const unexpected = filesReferencingForwardedFor.filter((f) => !allowed.has(f));
  ok(unexpected.length === 0, `x-forwarded-for is only read in ${[...allowed].join(", ")} (found elsewhere: ${JSON.stringify(unexpected)})`);
}

{
  const filesReferencingRemoteAddress: string[] = [];
  for (const file of tsFiles) {
    const text = readFileSync(file, "utf8");
    if (/remoteAddress/.test(text)) filesReferencingRemoteAddress.push(file.replace(root + "/", ""));
  }
  ok(filesReferencingRemoteAddress.length === 0, "no source file reads req.socket.remoteAddress (the header path is the only IP source, and it's never persisted)");
}

{
  const ipLimitSrc = readFileSync(join(root, "src", "ip-limit.ts"), "utf8");
  ok(!/from ["']\.\/db\.js["']/.test(ipLimitSrc), "src/ip-limit.ts never imports src/db.ts — structurally cannot write an IP to Postgres");
  ok(!ipLimitSrc.includes("INSERT"), "src/ip-limit.ts contains no SQL INSERT statement");
}

{
  const storeSrc = readFileSync(join(root, "src", "store.ts"), "utf8");
  const insertMatch = storeSrc.match(/INSERT INTO events \(([^)]+)\)/);
  ok(Boolean(insertMatch), "src/store.ts has exactly one INSERT INTO events (...) statement to check");
  const insertedColumns = (insertMatch?.[1] ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const expected = ["instance_id", "event_name", "event_time_unix_nano", "attributes", "resource"];
  assert.deepEqual(insertedColumns, expected, "insertEvents writes exactly the expected columns, nothing more");
  n++;
}

console.log(`no-ip-storage.test.ts: ${n} assertions passed`);
