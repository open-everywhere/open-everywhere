export interface AuditDumpRow {
  readonly ts?: string;
  readonly org?: string;
  readonly action?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditDumpInput {
  readonly actions: readonly string[];
  readonly sinceIso: string;
  readonly untilIso: string;
  readonly limit: number;
  readonly rows: readonly AuditDumpRow[];
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
    `  [idx ${idx}] ts=${row.ts ?? "<none>"} org=${row.org ?? "<none>"} action=${row.action ?? "<none>"} ` +
    `detail.tool=${tool === undefined ? "<none>" : String(tool)} detail=${renderDetail(row.detail)}`
  );
}

export const AUDIT_DUMP_BANNER = "--- OPE-1933 AUDIT DIAGNOSTIC (widened re-read after the wait timed out) ---";

export function formatAuditTimeoutDump(input: AuditDumpInput): string {
  const lines: string[] = [
    AUDIT_DUMP_BANNER,
    `re-read window: since=${input.sinceIso} until=${input.untilIso} limit=${input.limit}`,
    `wanted actions: ${input.actions.length > 0 ? input.actions.join(",") : "<none>"}`,
    `route flags: capped=${String(input.capped)} scanTruncated=${String(input.scanTruncated)} scanned=${input.scanned === undefined ? "<absent>" : String(input.scanned)}`,
    `rows for the wanted actions: ${input.rows.length}`,
  ];
  if (input.rows.length === 0) {
    lines.push(
      "  <none> — over a window 10 minutes WIDER than the wait's own, the row is still absent. " +
        "If scanTruncated is false, the row was never written; if it is true, the scan did not reach far enough to say.",
    );
  } else {
    lines.push(...input.rows.map(renderRow));
  }
  lines.push("--- end OPE-1933 audit diagnostic ---");
  return lines.join("\n");
}

export const AUDIT_DUMP_LOOKBACK_MS = 10 * 60 * 1000;

export const AUDIT_DUMP_LIMIT = 1000;
