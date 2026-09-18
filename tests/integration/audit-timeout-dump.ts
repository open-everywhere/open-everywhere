export interface AuditDumpRow {
  readonly seq?: number;
  readonly ts?: string;
  readonly org?: string;
  readonly action?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditDumpPendingRow {
  readonly id: string;
  readonly kind: string;
  readonly scopeKey: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface AuditDumpInput {
  readonly actions: readonly string[];
  readonly sinceIso: string;
  readonly limit: number;
  readonly rows: readonly AuditDumpRow[];
  readonly cursorMark: number;
  readonly cursorWallIso: string;
  readonly clockDriftMs: number;
  readonly sqlitePath?: string;
  readonly scopeKey?: string;
  readonly kind?: string;
  readonly scopeRows?: readonly AuditDumpRow[];
  readonly scopeError?: string;
  readonly pending?: readonly AuditDumpPendingRow[];
  readonly pendingError?: string;
  readonly capped?: boolean;
  readonly scanTruncated?: boolean;
  readonly scanned?: number;
}

const DETAIL_MAX_CHARS = 160;

function renderDetail(detail: Readonly<Record<string, unknown>> | undefined): string {
  if (detail === undefined) return "<no detail>";
  let text: string;
  try {
    text = JSON.stringify(detail);
  } catch {
    text = "<detail not serialisable>";
  }
  return text.length <= DETAIL_MAX_CHARS ? text : `${text.slice(0, DETAIL_MAX_CHARS)}…(+${text.length - DETAIL_MAX_CHARS} chars)`;
}

function renderRow(row: AuditDumpRow, idx: number): string {
  const tool = row.detail?.["tool"];
  return (
    `  [idx ${idx}] seq=${row.seq === undefined ? "<none>" : String(row.seq)} ts=${row.ts ?? "<none>"} ` +
    `org=${row.org ?? "<none>"} action=${row.action ?? "<none>"} ` +
    `detail.tool=${tool === undefined ? "<none>" : String(tool)} detail=${renderDetail(row.detail)}`
  );
}

function renderPending(row: AuditDumpPendingRow): string {
  return `    id=${row.id} kind=${row.kind} scopeKey=${row.scopeKey} status=${row.status} createdAt=${row.createdAt}`;
}

export const AUDIT_DUMP_BANNER = "--- OPE-1933 AUDIT DIAGNOSTIC (widened re-read after the wait timed out) ---";

export function formatAuditTimeoutDump(input: AuditDumpInput): string {
  const lines: string[] = [
    AUDIT_DUMP_BANNER,
    `re-read window: since=${input.sinceIso} until=<none: an upper bound is a wall-clock trap here> limit=${input.limit}`,
    `wait anchor: cursorMark=seq ${input.cursorMark} takenAt=${input.cursorWallIso}`,
    `clock drift since the anchor (wall − monotonic): ${input.clockDriftMs} ms` +
      (input.clockDriftMs < 0 ? " — NEGATIVE: this host's wall clock stepped BACKWARD while the wait ran" : ""),
    `operational sqlite handle: ${input.sqlitePath ?? "<not reported>"}`,
    `wanted actions: ${input.actions.length > 0 ? input.actions.join(",") : "<none>"}`,
    `route flags: capped=${String(input.capped)} scanTruncated=${String(input.scanTruncated)} scanned=${input.scanned === undefined ? "<absent>" : String(input.scanned)}`,
    `rows for the wanted actions: ${input.rows.length}`,
  ];
  if (input.rows.length === 0) {
    lines.push(
      "  <none> — over a window that starts TWICE the wait's own lookback below the wake and has no upper bound, " +
        "the row is still absent. If scanTruncated is false, the row was never written; if it is true, the scan did not reach far enough to say.",
    );
  } else {
    lines.push(...input.rows.map(renderRow));
  }
  if (input.scopeKey !== undefined || input.kind !== undefined) {
    lines.push(`scope: scopeKey=${input.scopeKey ?? "<none named — the reads below are this fork's whole log>"} kind=${input.kind ?? "<none>"}`);
    if (input.scopeError !== undefined) {
      lines.push(`  all-actions re-read UNAVAILABLE: ${input.scopeError}`);
    } else if (input.scopeRows === undefined) {
      lines.push("  all-actions re-read: <not requested>");
    } else {
      lines.push(`  ALL actions in the window${input.scopeKey === undefined ? "" : " for this scope"}: ${input.scopeRows.length}`);
      lines.push(...(input.scopeRows.length === 0 ? ["    <none> — nothing at all was audited in the window"] : input.scopeRows.map(renderRow)));
    }
    if (input.pendingError !== undefined) {
      lines.push(`  pending rows UNAVAILABLE: ${input.pendingError}`);
    } else if (input.pending === undefined) {
      lines.push("  pending rows: <not requested>");
    } else {
      lines.push(`  pending rows for (scopeKey, kind): ${input.pending.length}`);
      lines.push(...(input.pending.length === 0 ? ["    <none> — no pending row was ever minted for this scope and kind"] : input.pending.map(renderPending)));
    }
  }
  lines.push("--- end OPE-1933 audit diagnostic ---");
  return lines.join("\n");
}

export const AUDIT_DUMP_LIMIT = 1000;
