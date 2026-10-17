export interface InventoryRow {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly declared: string;
}

export interface NaDeclaration {
  readonly reason: string;
  readonly pending: boolean;
}

export type CellKind = "unit" | "integration" | "e2e" | "soak";

export function testCellKind(file: string): "unit" | "integration" {
  const path = file.split("\\").join("/");
  return path.startsWith("tests/integration/") && path.endsWith(".test.ts") ? "integration" : "unit";
}

export interface ProvesClaim {
  readonly ids: readonly string[];
  readonly source: string;
  readonly line: number;
  readonly kind: CellKind;
  readonly cell: string;
}

export interface MatrixCells {
  readonly unit: readonly string[];
  readonly integration: readonly string[];
  readonly e2e: readonly string[];
  readonly soak: readonly string[];
  readonly audit: readonly string[];
}

export interface MatrixRow {
  readonly row: InventoryRow;
  readonly cells: MatrixCells;
  readonly na?: NaDeclaration;
}

export type FindingKind = "uncovered" | "stale-row-id";

export interface Finding {
  readonly kind: FindingKind;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface FileSummary {
  readonly file: string;
  readonly rows: number;
  readonly covered: number;
  readonly naDeclared: number;
  readonly pending: number;
  readonly uncovered: number;
}

export const PENDING_REASON_PREFIX = "unannotated";

function splitCells(line: string): string[] {
  return line
    .slice(1)
    .replace(/\|\s*$/u, "")
    .split(/(?<!\\)\|/u)
    .map((c) => c.trim());
}

function bare(cell: string): string {
  return cell.trim().replace(/^`+|`+$/gu, "").replace(/\\\|/gu, "|").trim();
}

export function parseInventoryRows(text: string, file: string, warnings?: string[]): readonly InventoryRow[] {
  const out: InventoryRow[] = [];
  let columns = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("|")) {
      columns = 0;
      continue;
    }
    const cells = splitCells(line);
    const first = cells[0] ?? "";
    const last = cells[cells.length - 1] ?? "";
    if (/^(?:Id|ID)$/u.test(first) && last === "Tested by") {
      columns = cells.length;
      continue;
    }
    if (columns === 0) continue;
    if (/^:?-{3,}:?$/u.test(first.replace(/\s/gu, ""))) continue;
    if (cells.length !== columns) {
      warnings?.push(`${file}:${i + 1}: row has ${cells.length} cells against a ${columns}-cell header and was SKIPPED — this behaviour row is outside the matrix until the table is fixed.`);
      continue;
    }
    const id = bare(first);
    if (id === "") continue;
    out.push({ id, file, line: i + 1, declared: bare(last) });
  }
  return out;
}

export function parseNaDeclaration(cell: string): NaDeclaration | undefined {
  const match = /^n\/a\s*:\s*(\S.*)$/iu.exec(bare(cell));
  if (match === null) return undefined;
  const reason = (match[1] ?? "").trim();
  return { reason, pending: reason.toLowerCase().startsWith(PENDING_REASON_PREFIX) };
}

export interface ProvesAnnotation {
  readonly ids: readonly string[];
  readonly line: number;
}

export function parseProvesAnnotations(text: string): readonly ProvesAnnotation[] {
  const out: ProvesAnnotation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:\/\/|\*)\s*proves:\s*(\S.*)$/u.exec(lines[i] ?? "");
    if (match === null) continue;
    const ids = (match[1] ?? "")
      .split(",")
      .map((s) => bare(s))
      .filter((s) => s !== "");
    if (ids.length === 0) continue;
    out.push({ ids, line: i + 1 });
  }
  return out;
}

export function soakCheckerAfter(text: string, line: number): string | undefined {
  const lines = text.split("\n");
  for (let i = line; i < lines.length; i++) {
    const match = /^export function (check[A-Za-z0-9_]*)\s*\(/u.exec(lines[i] ?? "");
    if (match !== null) return match[1];
    if (/^\s*(?:\/\/|\*)\s*proves:/u.test(lines[i] ?? "")) return undefined;
  }
  return undefined;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function buildMatrix(
  rows: readonly InventoryRow[],
  claims: readonly ProvesClaim[],
  auditActions: ReadonlySet<string>,
): readonly MatrixRow[] {
  const byId = new Map<string, Record<CellKind, string[]>>();
  for (const row of rows) byId.set(row.id, { unit: [], integration: [], e2e: [], soak: [] });
  for (const claim of claims) {
    for (const id of claim.ids) {
      const bucket = byId.get(id);
      if (bucket === undefined) continue;
      bucket[claim.kind].push(claim.cell);
    }
  }
  return rows.map((row) => {
    const bucket = byId.get(row.id) ?? { unit: [], integration: [], e2e: [], soak: [] };
    const na = parseNaDeclaration(row.declared);
    return {
      row,
      cells: {
        unit: sortedUnique(bucket.unit),
        integration: sortedUnique(bucket.integration),
        e2e: sortedUnique(bucket.e2e),
        soak: sortedUnique(bucket.soak),
        audit: auditActions.has(row.id) ? [row.id] : [],
      },
      ...(na === undefined ? {} : { na }),
    };
  });
}

export function isCovered(entry: MatrixRow): boolean {
  const { unit, integration, e2e, soak, audit } = entry.cells;
  return unit.length + integration.length + e2e.length + soak.length + audit.length > 0;
}

export type RowClass = "covered" | "naDeclared" | "pending" | "uncovered";

export function classifyRow(entry: MatrixRow): RowClass {
  if (isCovered(entry)) return "covered";
  if (entry.na === undefined) return "uncovered";
  return entry.na.pending ? "pending" : "naDeclared";
}

export function findings(matrix: readonly MatrixRow[], claims: readonly ProvesClaim[]): readonly Finding[] {
  const out: Finding[] = [];
  for (const entry of matrix) {
    if (isCovered(entry) || entry.na !== undefined) continue;
    out.push({
      kind: "uncovered",
      file: entry.row.file,
      line: entry.row.line,
      message:
        `row \`${entry.row.id}\` has no unit test, no integration test, no e2e scenario, no soak checker and no audit action. ` +
        `Annotate the code that proves it with \`// proves: ${entry.row.id}\`, or declare the row ` +
        `\`n/a: <reason>\` in its Tested by cell.`,
    });
  }
  const known = new Set(matrix.map((entry) => entry.row.id));
  for (const claim of claims) {
    for (const id of claim.ids) {
      if (known.has(id)) continue;
      out.push({
        kind: "stale-row-id",
        file: claim.source,
        line: claim.line,
        message: `\`proves\` names \`${id}\`, which no inventory row carries. The row was renamed or removed, and this declaration now proves nothing.`,
      });
    }
  }
  return out;
}

export function summarise(matrix: readonly MatrixRow[]): readonly FileSummary[] {
  const order: string[] = [];
  const acc = new Map<string, { rows: number; covered: number; naDeclared: number; pending: number; uncovered: number }>();
  for (const entry of matrix) {
    let bucket = acc.get(entry.row.file);
    if (bucket === undefined) {
      bucket = { rows: 0, covered: 0, naDeclared: 0, pending: 0, uncovered: 0 };
      acc.set(entry.row.file, bucket);
      order.push(entry.row.file);
    }
    bucket.rows++;
    bucket[classifyRow(entry)]++;
  }
  return order.map((file) => ({ file, ...(acc.get(file) as { rows: number; covered: number; naDeclared: number; pending: number; uncovered: number }) }));
}

export function coverageReportLines(matrix: readonly MatrixRow[]): string[] {
  const summaries = summarise(matrix);
  const all = totals(summaries);
  const out: string[] = [];
  out.push("| Inventory page | Rows | Covered | n/a | Pending | Uncovered |");
  out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const s of summaries) {
    out.push(`| ${s.file} | ${s.rows} | ${s.covered} | ${s.naDeclared} | ${s.pending} | ${s.uncovered} |`);
  }
  out.push(`| **total** | **${all.rows}** | **${all.covered}** | **${all.naDeclared}** | **${all.pending}** | **${all.uncovered}** |`);
  out.push("");
  const cellCount = (pick: (e: MatrixRow) => readonly string[]): number => matrix.filter((e) => pick(e).length > 0).length;
  out.push(
    `Cells filled: unit ${cellCount((e) => e.cells.unit)} · integration ${cellCount((e) => e.cells.integration)} · ` +
      `e2e ${cellCount((e) => e.cells.e2e)} · ` +
      `soak ${cellCount((e) => e.cells.soak)} · audit ${cellCount((e) => e.cells.audit)}.`,
  );
  out.push(
    "Pending counts rows declared `n/a: unannotated …` — UNANSWERED, not exempt. They are the remaining work, " +
      "and they print apart from a real exemption so a seeded gate cannot read as a finished one.",
  );
  return out;
}

export function totals(summaries: readonly FileSummary[]): Omit<FileSummary, "file"> {
  const sum = (pick: (s: FileSummary) => number): number => summaries.reduce((a, s) => a + pick(s), 0);
  return {
    rows: sum((s) => s.rows),
    covered: sum((s) => s.covered),
    naDeclared: sum((s) => s.naDeclared),
    pending: sum((s) => s.pending),
    uncovered: sum((s) => s.uncovered),
  };
}

export function summaryDisagreements(matrix: readonly MatrixRow[], summaries: readonly FileSummary[]): string[] {
  const problems: string[] = [];
  for (const s of summaries) {
    const parts = s.covered + s.naDeclared + s.pending + s.uncovered;
    if (parts !== s.rows) {
      problems.push(
        `${s.file}: ${s.rows} rows, but the four buckets sum to ${parts} ` +
          `(covered ${s.covered} + n/a ${s.naDeclared} + pending ${s.pending} + uncovered ${s.uncovered}). ` +
          "A row is counted twice, or not at all.",
      );
    }
  }
  const all = totals(summaries);
  if (all.rows !== matrix.length) {
    problems.push(`the per-page table covers ${all.rows} rows, but the matrix holds ${matrix.length}. A page was dropped.`);
  }
  const direct = { covered: 0, naDeclared: 0, pending: 0, uncovered: 0 };
  for (const entry of matrix) direct[classifyRow(entry)]++;
  for (const key of ["covered", "naDeclared", "pending", "uncovered"] as const) {
    if (direct[key] !== all[key]) {
      problems.push(`the totals row says ${key}=${all[key]}, but the matrix classifies ${direct[key]} rows that way.`);
    }
  }
  return problems;
}

const LAUNCH_SURFACES = ["slack", "notion", "github"] as const;
const SECOND_SURFACES = ["discord", "teams"] as const;

export type LegVerdict = "green" | "red" | "not-run" | "gap";

export interface BoardLegInput {
  readonly id: string;
  readonly surface: string;
  readonly status: string;
  readonly reason?: string;
}

export interface SurfaceTally {
  readonly surface: string;
  readonly green: number;
  readonly red: number;
  readonly notRun: number;
  readonly gap: number;
}

export function legVerdict(status: string): LegVerdict {
  const upper = status.trim().toUpperCase();
  if (upper === "GREEN") return "green";
  if (upper === "GAP") return "gap";
  if (upper === "DEFERRED" || upper === "FILTERED") return "not-run";
  return "red";
}

export function tallyBySurface(legs: readonly BoardLegInput[]): readonly SurfaceTally[] {
  const order: string[] = [];
  type Bucket = { green: number; red: number; notRun: number; gap: number };
  const acc = new Map<string, Bucket>();
  for (const leg of legs) {
    let bucket = acc.get(leg.surface);
    if (bucket === undefined) {
      bucket = { green: 0, red: 0, notRun: 0, gap: 0 };
      acc.set(leg.surface, bucket);
      order.push(leg.surface);
    }
    const verdict = legVerdict(leg.status);
    if (verdict === "green") bucket.green++;
    else if (verdict === "red") bucket.red++;
    else if (verdict === "gap") bucket.gap++;
    else bucket.notRun++;
  }
  return order.map((surface) => ({ surface, ...(acc.get(surface) as Bucket) }));
}

function renderSurface(tally: SurfaceTally | undefined, surface: string): string {
  if (tally === undefined) return `${surface} —`;
  return `${surface} ${tally.green}✓/${tally.red}✗/${tally.notRun}·/${tally.gap}◌`;
}

export function legBoardLines(legs: readonly BoardLegInput[]): string[] {
  const tallies = tallyBySurface(legs);
  const byName = new Map(tallies.map((t) => [t.surface, t]));
  const named = new Set<string>([...LAUNCH_SURFACES, ...SECOND_SURFACES]);
  const rest = tallies.map((t) => t.surface).filter((s) => !named.has(s));
  const totalGreen = tallies.reduce((a, t) => a + t.green, 0);
  const totalRed = tallies.reduce((a, t) => a + t.red, 0);
  const totalNotRun = tallies.reduce((a, t) => a + t.notRun, 0);
  const totalGap = tallies.reduce((a, t) => a + t.gap, 0);

  const out: string[] = [];
  out.push(`LAUNCH   ${LAUNCH_SURFACES.map((s) => renderSurface(byName.get(s), s)).join("  ")}`);
  out.push(`also     ${SECOND_SURFACES.map((s) => renderSurface(byName.get(s), s)).join("  ")}`);
  if (rest.length > 0) out.push(`other    ${rest.map((s) => renderSurface(byName.get(s), s)).join("  ")}`);
  out.push("");
  out.push(
    `${legs.length} legs — ${totalGreen} green, ${totalRed} red, ${totalNotRun} not-run, ${totalGap} declared gap. ` +
      `Key: green✓/red✗/not-run·/gap◌`,
  );
  out.push("A red on the `also` line is exactly as red as one on the LAUNCH line — the order is reporting, not severity.");
  if (totalRed > 0) {
    const reds = legs.filter((l) => legVerdict(l.status) === "red");
    out.push("");
    out.push("RED legs:");
    for (const leg of reds) out.push(`  ${leg.id} (${leg.surface}) — ${leg.reason ?? "no reason recorded"}`);
  }
  if (totalGap > 0) {
    const gaps = legs.filter((l) => legVerdict(l.status) === "gap");
    out.push("");
    out.push("DECLARED GAPS (a fixture nobody has provisioned, on a surface this launch does not gate on):");
    for (const leg of gaps) out.push(`  ${leg.id} (${leg.surface}) — ${leg.reason ?? "no reason recorded"}`);
  }
  return out;
}

export function parseLegsJson(text: string): readonly BoardLegInput[] {
  const parsed: unknown = JSON.parse(text);
  const raw = Array.isArray(parsed) ? parsed : (parsed as { legs?: unknown }).legs;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("the results JSON holds no leg — expected a `BoardLeg[]` or `{ legs: [...] }` with at least one entry.");
  }
  return raw.map((entry) => {
    const leg = entry as { id?: unknown; surface?: unknown; status?: unknown; reason?: unknown };
    return {
      id: String(leg.id ?? "<unnamed>"),
      surface: String(leg.surface ?? "<unknown>"),
      status: String(leg.status ?? ""),
      ...(typeof leg.reason === "string" ? { reason: leg.reason } : {}),
    };
  });
}

export function parseLegsBoard(text: string): readonly BoardLegInput[] {
  const out: BoardLegInput[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = splitCells(line.trim());
    if (cells[0] === "Leg" && cells[1] === "Surface" && cells[2] === "Status") {
      inTable = true;
      continue;
    }
    if (!inTable || cells.length < 4) continue;
    if (/^:?-{3,}:?$/u.test((cells[0] ?? "").replace(/\s/gu, ""))) continue;
    out.push({
      id: cells[0] ?? "",
      surface: cells[1] ?? "",
      status: cells[2] ?? "",
      reason: cells.slice(3).join(" | ").replace(/\\\|/gu, "|").trim(),
    });
  }
  if (out.length === 0) {
    throw new Error("no `| Leg | Surface | Status |` table found in the supplied runner output.");
  }
  return out;
}
