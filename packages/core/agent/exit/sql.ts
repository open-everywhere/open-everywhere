import { catalogueColumns, exitTableSpec, type ExitTableSpec } from "./catalogue.js";

export const EXIT_PAGE_BYTES = 8 * 1024 * 1024;

export type ExitPlaceholderStyle = "dollar" | "qmark";

export interface ExitRowFilter {
  readonly anyOf?: readonly { readonly column: string; readonly values: readonly string[] }[];
  readonly allOf?: readonly { readonly column: string; readonly values: readonly string[] }[];
  readonly olderThan?: { readonly column: string; readonly before: string };
}

export interface ExitSql {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function specOf(table: string): ExitTableSpec {
  const spec = exitTableSpec(table);
  if (spec === undefined) throw new Error(`exit kit: "${table}" is not an operational table the catalogue holds`);
  return spec;
}

function column(spec: ExitTableSpec, name: string): string {
  if (!catalogueColumns(spec).has(name)) throw new Error(`exit kit: "${spec.table}" has no catalogued column "${name}"`);
  return name;
}

class Params {
  readonly values: unknown[] = [];
  constructor(private readonly style: ExitPlaceholderStyle) {}
  add(value: unknown): string {
    this.values.push(value);
    return this.style === "dollar" ? `$${this.values.length}` : "?";
  }
}

function whereClause(spec: ExitTableSpec, org: string | null, filter: ExitRowFilter | undefined, p: Params): string {
  const parts: string[] = [];
  if (spec.orgColumn !== null) {
    if (org === null) throw new Error(`exit kit: "${spec.table}" is keyed by org, and the call named none`);
    parts.push(`${spec.orgColumn} = ${p.add(org)}`);
  }
  const anyOf = filter?.anyOf ?? [];
  if (anyOf.length > 0) {
    const ors: string[] = [];
    for (const term of anyOf) {
      const col = column(spec, term.column);
      if (term.values.length === 0) continue;
      ors.push(`${col} IN (${term.values.map((v) => p.add(v)).join(", ")})`);
    }
    parts.push(ors.length > 0 ? `(${ors.join(" OR ")})` : "1 = 0");
  }
  for (const term of filter?.allOf ?? []) {
    const col = column(spec, term.column);
    parts.push(term.values.length > 0 ? `${col} IN (${term.values.map((v) => p.add(v)).join(", ")})` : "1 = 0");
  }
  if (filter?.olderThan !== undefined) {
    parts.push(`${column(spec, filter.olderThan.column)} < ${p.add(filter.olderThan.before)}`);
  }
  return parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
}

export function buildExitSelectPage(style: ExitPlaceholderStyle, table: string, org: string | null, offset: number, limit: number): ExitSql {
  const spec = specOf(table);
  const p = new Params(style);
  const where = whereClause(spec, org, undefined, p);
  const order = spec.orderBy.map((c) => column(spec, c)).join(", ");
  const sql = `SELECT * FROM ${spec.table}${where} ORDER BY ${order} LIMIT ${p.add(Math.max(1, Math.floor(limit)))} OFFSET ${p.add(Math.max(0, Math.floor(offset)))}`;
  return { sql, params: p.values };
}

export function buildExitRowSizes(table: string, org: string | null, offset: number, limit: number): ExitSql {
  const spec = specOf(table);
  const p = new Params("dollar");
  const where = whereClause(spec, org, undefined, p);
  const order = spec.orderBy.map((c) => column(spec, c)).join(", ");
  const sql = `SELECT octet_length(CAST(t AS text)) AS n FROM (SELECT * FROM ${spec.table}${where} ORDER BY ${order} LIMIT ${p.add(Math.max(1, Math.floor(limit)))} OFFSET ${p.add(Math.max(0, Math.floor(offset)))}) t ORDER BY ${order}`;
  return { sql, params: p.values };
}

export function rowsWithinBytes(sizes: readonly number[], maxBytes: number): number {
  let total = 0;
  let k = 0;
  for (const n of sizes) {
    total += Number(n);
    if (k > 0 && total > maxBytes) break;
    k++;
  }
  return k;
}

export function buildExitSelectDistinct(style: ExitPlaceholderStyle, table: string, org: string, col: string, filter: ExitRowFilter): ExitSql {
  const spec = specOf(table);
  const p = new Params(style);
  const name = column(spec, col);
  const where = whereClause(spec, org, filter, p);
  return { sql: `SELECT DISTINCT ${name} AS v FROM ${spec.table}${where}${where ? " AND" : " WHERE"} ${name} IS NOT NULL`, params: p.values };
}

export function buildExitDelete(style: ExitPlaceholderStyle, table: string, org: string, filter: ExitRowFilter): ExitSql {
  const spec = specOf(table);
  if (spec.appendOnly) throw new Error(`exit kit: "${spec.table}" is append-only — the exit kit never deletes from it`);
  if ((filter.anyOf === undefined || filter.anyOf.length === 0) && filter.olderThan === undefined) {
    throw new Error(`exit kit: a delete on "${spec.table}" needs a filter — it never empties a table`);
  }
  const p = new Params(style);
  const where = whereClause(spec, org, filter, p);
  return { sql: `DELETE FROM ${spec.table}${where} RETURNING 1`, params: p.values };
}
