import type { DatabaseSync } from "node:sqlite";
import type { PgClient } from "../agent/operational/postgres.js";
import { initOperationalSchema, makeOperationalPostgresStore } from "../agent/operational/postgres.js";
import { initPostgresSchema } from "../agent/memory/postgres.js";
import { findChainBreak } from "../agent/audit/chain.js";
import { OPERATIONAL_TABLES } from "../agent/operational/store.js";

const MEMORY_TABLES = ["memory_file", "memory_tier"] as const;

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`migrate: unsafe identifier "${name}"`);
  return `"${name}"`;
}

interface TargetColumn {
  readonly name: string;
  readonly dataType: string;
  readonly isIdentity: boolean;
}

async function targetColumns(target: PgClient, table: string): Promise<TargetColumn[]> {
  const { rows } = await target.query(
    `SELECT column_name, data_type, is_identity
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return (rows as { column_name: string; data_type: string; is_identity: string }[]).map((r) => ({
    name: r.column_name,
    dataType: r.data_type,
    isIdentity: r.is_identity === "YES",
  }));
}

function sourceColumns(source: DatabaseSync, table: string): Set<string> {
  const rows = source.prepare(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function sourceTables(source: DatabaseSync): Set<string> {
  const rows = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function sourceCount(source: DatabaseSync, table: string): number {
  const r = source.prepare(`SELECT count(*) AS n FROM ${ident(table)}`).get() as { n: number | bigint };
  return Number(r.n);
}

async function targetCount(target: PgClient, table: string): Promise<number> {
  const { rows } = await target.query(`SELECT count(*)::int AS n FROM ${ident(table)}`);
  return Number((rows[0] as { n: number }).n);
}

function convertForTarget(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "boolean" && typeof value === "number") return value !== 0;
  if (dataType.startsWith("timestamp") && typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "bigint") return value.toString();
  return value;
}

export interface TableCount {
  readonly table: string;
  readonly source: number;
  readonly target: number;
}

async function copyTable(source: DatabaseSync, target: PgClient, table: string): Promise<TableCount> {
  const tcols = await targetColumns(target, table);
  const scols = sourceColumns(source, table);
  const copy = tcols.filter((c) => !c.isIdentity && scols.has(c.name));
  if (copy.length === 0) {
    throw new Error(`migrate: table "${table}" has no copyable columns (source/target column sets do not overlap)`);
  }
  const colList = copy.map((c) => c.name);
  const orderBy = scols.has("seq") ? " ORDER BY seq ASC" : "";
  const selectSql = `SELECT ${colList.map(ident).join(", ")} FROM ${ident(table)}${orderBy}`;
  const rows = source.prepare(selectSql).all() as Record<string, unknown>[];

  const before = await targetCount(target, table);
  const placeholders = colList.map((_, i) => `$${i + 1}`).join(", ");
  const insertSql = `INSERT INTO ${ident(table)} (${colList.map(ident).join(", ")}) VALUES (${placeholders})`;
  let inserted = 0;
  for (const row of rows) {
    const params = copy.map((c) => convertForTarget(row[c.name], c.dataType));
    try {
      await target.query(insertSql, params);
    } catch (err) {
      throw new Error(`migrate: FAILED inserting row ${inserted + 1}/${rows.length} into "${table}": ${String(err)}`);
    }
    inserted++;
  }
  const after = await targetCount(target, table);
  if (after - before !== rows.length) {
    throw new Error(`migrate: row-count mismatch on "${table}" after copy (source ${rows.length}, target delta ${after - before})`);
  }
  return { table, source: rows.length, target: after };
}

export interface MemoryMigrationResult {
  readonly status: string;
  readonly tables?: TableCount[];
}

export interface MigrateReport {
  readonly tables: TableCount[];
  readonly chainOrgs: number;
  readonly memory: MemoryMigrationResult;
}

export interface MigrateOptions {
  readonly source: DatabaseSync;
  readonly target: PgClient;
  readonly forceEmptyCheckOff?: boolean;
  readonly memoryProvider?: string;
  readonly log?: (msg: string) => void;
}

function assertTargetEmpty(nonEmpty: string[], what: string): void {
  if (nonEmpty.length > 0) {
    throw new Error(
      `migrate: target ${what} is NOT empty (${nonEmpty.join(", ")} already hold rows) — refusing to merge/clobber. ` +
        "Point at a FRESH database, or pass --force-empty-check-off if you deliberately intend to add to it.",
    );
  }
}

export async function migrateOperational(opts: MigrateOptions): Promise<MigrateReport> {
  const log = opts.log ?? (() => {});

  await initOperationalSchema(opts.target);

  const present = sourceTables(opts.source);
  const tablesToCopy = OPERATIONAL_TABLES.filter((t) => present.has(t));
  const missing = OPERATIONAL_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    log(`  note: source has no ${missing.join(", ")} table(s) — nothing to copy for those (0 rows).`);
  }

  if (!opts.forceEmptyCheckOff) {
    const nonEmpty: string[] = [];
    for (const t of tablesToCopy) if ((await targetCount(opts.target, t)) > 0) nonEmpty.push(t);
    assertTargetEmpty(nonEmpty, "operational store");
  }

  log("operational tables:");
  const tables: TableCount[] = [];
  for (const t of tablesToCopy) {
    const c = await copyTable(opts.source, opts.target, t);
    log(`  ${t.padEnd(20)} source ${String(c.source).padStart(7)}  →  target ${String(c.target).padStart(7)}`);
    tables.push(c);
  }

  const store = makeOperationalPostgresStore(opts.target);
  const orgs = await store.listAuditOrgs();
  for (const org of orgs) {
    const chainRows = await store.readAuditChain(org);
    const brk = findChainBreak(chainRows, { expectGenesis: true });
    if (brk) {
      throw new Error(
        `migrate: audit hash-chain verification FAILED on the target for org "${org}" at seq ${brk.seq} ` +
          `(${brk.reason}) — the migration is ABORTED. The SOURCE chain was likely already broken; ` +
          "investigate with scripts/verify-audit-chain.ts before retrying.",
      );
    }
  }
  log(`audit chain verified on target: ${orgs.length} org chain(s) intact.`);

  const memory = await migrateMemoryBacking(opts, log);

  return { tables, chainOrgs: orgs.length, memory };
}

async function migrateMemoryBacking(opts: MigrateOptions, log: (msg: string) => void): Promise<MemoryMigrationResult> {
  const provider = (opts.memoryProvider ?? "git").trim() || "git";
  if (provider === "git") {
    log("memory backing is git — nothing to migrate (git history is off-DB / already portable).");
    return { status: "git: nothing to migrate" };
  }
  if (provider === "postgres") {
    log("memory backing is already postgres — nothing to migrate.");
    return { status: "postgres: nothing to migrate" };
  }
  if (provider !== "sqlite") {
    log(`memory backing is "${provider}" — not a local sqlite DB, nothing to migrate here.`);
    return { status: `${provider}: nothing to migrate` };
  }

  await initPostgresSchema(opts.target);
  const present = sourceTables(opts.source);
  const tablesToCopy = MEMORY_TABLES.filter((t) => present.has(t));
  if (tablesToCopy.length === 0) {
    log("memory backing is sqlite but the source has no memory tables yet — nothing to migrate.");
    return { status: "sqlite: no memory tables present" };
  }
  if (!opts.forceEmptyCheckOff) {
    const nonEmpty: string[] = [];
    for (const t of tablesToCopy) if ((await targetCount(opts.target, t)) > 0) nonEmpty.push(t);
    assertTargetEmpty(nonEmpty, "memory store");
  }
  log("memory tables (sqlite → postgres):");
  const tables: TableCount[] = [];
  for (const t of tablesToCopy) {
    const c = await copyTable(opts.source, opts.target, t);
    log(`  ${t.padEnd(20)} source ${String(c.source).padStart(7)}  →  target ${String(c.target).padStart(7)}`);
    tables.push(c);
  }
  return { status: "sqlite → postgres: copied", tables };
}
