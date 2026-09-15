import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAuditWindow, type AuditWireEntry } from "./audit-read.js";
import { REPLY_POST_ACTION, WAKE_INGRESS_ACTION, dispatchedAction } from "./engaged-rows.js";
import { WAKE_TURN_START_ACTION } from "../../agent/channels/wake-timing.js";

export type WakeEvidenceKind = "ingress" | "turn-start" | "dispatched" | "reply" | "wake-failed" | "rate-limited";

export interface WakeEvidenceRow {
  readonly ts: string;
  readonly platform: string;
  readonly action: string;
  readonly kind: WakeEvidenceKind;
  readonly ids: Readonly<Record<string, string>>;
}

export interface LegWakeWindow {
  readonly legId: string;
  readonly surface: string;
  readonly sinceIso: string;
  readonly untilIso: string;
}

export interface LegWakeEvidence extends LegWakeWindow {
  readonly status: string;
  readonly rows: readonly WakeEvidenceRow[];
  readonly windowRows: number;
  readonly incomplete: boolean;
  readonly error?: string;
}

const ID_KEYS = [
  "wakeId",
  "deliveryId",
  "sessionId",
  "rootSessionId",
  "turnId",
  "surfaceKey",
  "threadKey",
  "route",
  "reason",
  "status",
  "failure",
  "addressing",
  "via",
  "vendorTs",
  "vendorTsSource",
  "ingressTs",
  "vendorToIngressMs",
  "chars",
] as const;

function idValue(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function idsOf(detail: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!detail) return out;
  for (const key of ID_KEYS) {
    const v = idValue(detail[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const DISPATCHED_SUFFIX = dispatchedAction("");

export const WAKE_FAILED_ACTION = "surface.wake_failed";

const REPLY_POST_FAILED_ACTION = `${REPLY_POST_ACTION}.failed`;

function isRateLimited(detail: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!detail) return false;
  const status = detail["status"];
  return status === 429 || status === "429";
}

export function classifyWakeRow(row: Pick<AuditWireEntry, "action" | "detail">): WakeEvidenceKind | null {
  if (isRateLimited(row.detail)) return "rate-limited";
  if (row.action === WAKE_INGRESS_ACTION) return "ingress";
  if (row.action === WAKE_TURN_START_ACTION) return "turn-start";
  if (row.action.endsWith(DISPATCHED_SUFFIX)) return "dispatched";
  if (row.action === REPLY_POST_ACTION || row.action === REPLY_POST_FAILED_ACTION) return "reply";
  if (row.action === WAKE_FAILED_ACTION) return "wake-failed";
  return null;
}

export function selectWakeEvidence(rows: readonly AuditWireEntry[], window: Pick<LegWakeWindow, "sinceIso" | "untilIso">): readonly WakeEvidenceRow[] {
  const from = Date.parse(window.sinceIso);
  const to = Date.parse(window.untilIso);
  const out: WakeEvidenceRow[] = [];
  for (const row of rows) {
    const at = Date.parse(row.ts);
    if (Number.isNaN(at) || at < from || at > to) continue;
    const kind = classifyWakeRow(row);
    if (kind === null) continue;
    out.push({ ts: row.ts, platform: row.platform, action: row.action, kind, ids: idsOf(row.detail) });
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

export type WakeAuditRead = (opts: {
  sinceIso: string;
  untilIso: string;
  limit: number;
  timeoutMs: number;
}) => Promise<Awaited<ReturnType<typeof fetchAuditWindow>>>;

export async function captureWakeEvidence(
  read: WakeAuditRead | undefined,
  leg: LegWakeWindow & { readonly status: string },
  opts: { readonly limit: number; readonly timeoutMs: number },
): Promise<LegWakeEvidence> {
  const base = { ...leg, rows: [] as readonly WakeEvidenceRow[], windowRows: 0, incomplete: true };
  if (!read) return { ...base, error: "no audit reader (E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN unset)" };
  try {
    const page = await read({ sinceIso: leg.sinceIso, untilIso: leg.untilIso, limit: opts.limit, timeoutMs: opts.timeoutMs });
    return {
      ...leg,
      rows: selectWakeEvidence(page.entries, leg),
      windowRows: page.entries.length,
      incomplete: page.capped || page.scanTruncated,
    };
  } catch (err) {
    return { ...base, error: String(err instanceof Error ? err.message : err) };
  }
}

export function renderLegWakeEvidence(evidence: LegWakeEvidence): string[] {
  const head = `wake evidence ${evidence.legId} (${evidence.surface}, ${evidence.status}) window ${evidence.sinceIso} → ${evidence.untilIso}`;
  if (evidence.error !== undefined) return [`${head}: NOT CAPTURED — ${evidence.error} (this is not an absence of rows)`];
  if (evidence.rows.length === 0) {
    const caveat = evidence.incomplete
      ? "the read could not see the whole window, so this is NOT evidence the rows are absent"
      : "the window was read in full, so no decisive row is logged INSIDE it — a row stamped after the leg closed falls outside this window";
    return [`${head}: no decisive rows of ${evidence.windowRows} in the window — ${caveat}`];
  }
  const out = [`${head}: ${evidence.rows.length} decisive row(s) of ${evidence.windowRows}${evidence.incomplete ? " (window read INCOMPLETE)" : ""}`];
  for (const row of evidence.rows) {
    const ids = Object.entries(row.ids)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    out.push(`  ${row.ts} ${row.platform}.${row.action} [${row.kind}]${ids ? ` ${ids}` : ""}`);
  }
  return out;
}

export function wakeEvidenceResultsDir(): string {
  return join(process.cwd(), "scripts/e2e/results");
}

export function writeWakeEvidence(
  records: readonly LegWakeEvidence[],
  meta: { readonly startedAt: string; readonly target?: string },
): string | null {
  if (records.length === 0) return null;
  const dir = wakeEvidenceResultsDir();
  mkdirSync(dir, { recursive: true });
  const finishedAt = new Date().toISOString();
  const path = join(dir, `e2e-wake-evidence-${finishedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    path,
    JSON.stringify({ config: { target: meta.target ?? null }, startedAt: meta.startedAt, finishedAt, legs: records }, null, 2),
  );
  return path;
}
