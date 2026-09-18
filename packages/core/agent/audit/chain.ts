import { createHash } from "node:crypto";
import type { AuditChainRow } from "../operational/store.js";

export interface HashableAuditRow {
  readonly org: string;
  readonly ts: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly surfaceMode?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export function auditRowSha(row: HashableAuditRow, prevSha: string | null): string {
  const fields: unknown[] = [
    prevSha,
    row.org,
    row.ts,
    row.platform,
    row.workspace,
    row.surface ?? null,
    row.principalId ?? null,
    row.action,
    row.detail === undefined ? null : stableStringify(row.detail),
  ];
  if (row.surfaceMode !== undefined) fields.push(row.surfaceMode);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export const AUDIT_CHAIN_EPOCH_ACTION = "audit.chain_epoch";

export interface AuditEpochSeal {
  readonly rowsBefore: number;
  readonly firstSeqBefore: number | null;
  readonly lastSeqBefore: number | null;
  readonly breaksBefore: number;
  readonly eraDigest: string;
}

export function auditEraDigest(rows: readonly AuditChainRow[]): string {
  const h = createHash("sha256");
  for (const row of rows) h.update(`${auditRowSha(row, row.prevSha)}\n`);
  return h.digest("hex");
}

export function auditEpochDetail(seal: AuditEpochSeal): Record<string, unknown> {
  return {
    epoch: {
      rows_before: seal.rowsBefore,
      first_seq_before: seal.firstSeqBefore,
      last_seq_before: seal.lastSeqBefore,
      breaks_before: seal.breaksBefore,
      era_digest: seal.eraDigest,
    },
  };
}

export function readAuditEpochSeal(row: Pick<AuditChainRow, "action" | "prevSha" | "detail">): AuditEpochSeal | null {
  if (row.action !== AUDIT_CHAIN_EPOCH_ACTION || row.prevSha !== null) return null;
  const envelope = row.detail?.epoch;
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const e = envelope as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const nullableNum = (v: unknown): number | null | undefined => (v === null ? null : num(v) === null ? undefined : num(v));
  const rowsBefore = num(e.rows_before);
  const breaksBefore = num(e.breaks_before);
  const firstSeqBefore = nullableNum(e.first_seq_before);
  const lastSeqBefore = nullableNum(e.last_seq_before);
  const eraDigest = e.era_digest;
  if (rowsBefore === null || breaksBefore === null) return null;
  if (firstSeqBefore === undefined || lastSeqBefore === undefined) return null;
  if (typeof eraDigest !== "string" || !/^[0-9a-f]{64}$/.test(eraDigest)) return null;
  return { rowsBefore, firstSeqBefore, lastSeqBefore, breaksBefore, eraDigest };
}

export interface AuditEpochBoundary {
  readonly index: number;
  readonly seq: number;
  readonly ts: string;
  readonly org: string;
  readonly seal: AuditEpochSeal;
  readonly sealVerified: boolean;
}

export interface ChainBreak {
  readonly index: number;
  readonly seq: number;
  readonly ts: string;
  readonly org: string;
  readonly action: string;
  readonly reason: string;
  readonly expectedPrev: string | null;
  readonly actualPrev: string | null;
}

export function findChainBreak(rows: readonly AuditChainRow[], opts?: { readonly expectGenesis?: boolean }): ChainBreak | null {
  return walkAuditChain(rows, opts).breaks[0] ?? null;
}

export interface AuditChainWalk {
  readonly breaks: readonly ChainBreak[];
  readonly epochs: readonly AuditEpochBoundary[];
  readonly rowsWalked: number;
  readonly sealedThroughIndex: number;
  readonly breaksInsideSealedEra: number;
}

export function walkAuditChain(rows: readonly AuditChainRow[], opts?: { readonly expectGenesis?: boolean }): AuditChainWalk {
  const breaks: ChainBreak[] = [];
  const epochs: AuditEpochBoundary[] = [];
  let sealedThroughIndex = -1;
  let breaksInsideSealedEra = 0;
  if (rows.length === 0) return { breaks, epochs, rowsWalked: 0, sealedThroughIndex, breaksInsideSealedEra };
  const fullWalk = opts?.expectGenesis ?? false;

  const crossEpoch = (index: number, row: AuditChainRow, seal: AuditEpochSeal): void => {
    let mismatch: string | null = null;
    if (fullWalk) {
      if (seal.rowsBefore !== index)
        mismatch = `epoch seal claims ${seal.rowsBefore} preceding row(s) but ${index} are present (pre-epoch rows were added or removed)`;
      else if (seal.eraDigest !== auditEraDigest(rows.slice(0, index)))
        mismatch = `epoch seal does not match the era it covers (era digest disagrees over ${index} row(s) — a pre-epoch row was mutated, or the rows were reordered)`;
      else if (seal.breaksBefore !== breaks.length)
        mismatch = `epoch seal claims ${seal.breaksBefore} broken link(s) in the era it covers but the walk finds ${breaks.length} (the seal under-reports what it sealed)`;
    }
    const sealVerified = fullWalk && mismatch === null;
    epochs.push({ index, seq: row.seq, ts: row.ts, org: row.org, seal, sealVerified });
    if (mismatch !== null) {
      breaks.push({ index, seq: row.seq, ts: row.ts, org: row.org, action: row.action, reason: mismatch, expectedPrev: null, actualPrev: null });
    } else if (sealVerified) {
      breaksInsideSealedEra += breaks.length;
      breaks.length = 0;
      sealedThroughIndex = index;
    }
  };

  const first = rows[0];
  const firstSeal = readAuditEpochSeal(first);
  if (firstSeal !== null) {
    crossEpoch(0, first, firstSeal);
  } else if (fullWalk && first.prevSha !== null) {
    breaks.push({
      index: 0,
      seq: first.seq,
      ts: first.ts,
      org: first.org,
      action: first.action,
      reason: "genesis row carries a non-null prev_sha (rows before it were removed, or the chain was reset)",
      expectedPrev: null,
      actualPrev: first.prevSha,
    });
  }
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const seal = readAuditEpochSeal(cur);
    if (seal !== null) {
      crossEpoch(i, cur, seal);
      continue;
    }
    const expected = auditRowSha(prev, prev.prevSha);
    if (cur.prevSha !== expected) {
      breaks.push({
        index: i,
        seq: cur.seq,
        ts: cur.ts,
        org: cur.org,
        action: cur.action,
        reason:
          cur.prevSha === null
            ? "prev_sha is null mid-chain (a row's link was cleared — truncation/reset, or a pre-chain row that no epoch marker seals)"
            : "prev_sha does not match the recomputed hash of the preceding row (the predecessor was mutated, a row between them was deleted, or two writers appended concurrently and forked the chain)",
        expectedPrev: expected,
        actualPrev: cur.prevSha,
      });
    }
  }
  return { breaks, epochs, rowsWalked: rows.length, sealedThroughIndex, breaksInsideSealedEra };
}

export function auditEpochSealFor(rows: readonly AuditChainRow[]): AuditEpochSeal | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  if (readAuditEpochSeal(last) !== null) return null;
  return {
    rowsBefore: rows.length,
    firstSeqBefore: rows[0].seq,
    lastSeqBefore: last.seq,
    breaksBefore: walkAuditChain(rows, { expectGenesis: true }).breaks.length,
    eraDigest: auditEraDigest(rows),
  };
}

export function breaksByAction(breaks: readonly ChainBreak[]): { readonly action: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const b of breaks) counts.set(b.action, (counts.get(b.action) ?? 0) + 1);
  return [...counts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
}

const orgAppendChains = new Map<string, Promise<unknown>>();

export function withOrgAuditLock<T>(org: string, fn: () => Promise<T>): Promise<T> {
  const prev = orgAppendChains.get(org) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  orgAppendChains.set(
    org,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export interface AuditChainOrgReport {
  readonly org: string;
  readonly break: ChainBreak | null;
  readonly breaks: readonly ChainBreak[];
  readonly epochs: readonly AuditEpochBoundary[];
  readonly error?: string;
}

export interface AuditChainReadable {
  listAuditOrgs(): Promise<string[]>;
  readAuditChain(org: string, opts?: { readonly tailLimit?: number }): Promise<AuditChainRow[]>;
}

const BOOT_TAIL_LIMIT = 32;

export async function verifyAuditChainTail(store: AuditChainReadable, opts?: { readonly perOrgTail?: number }): Promise<AuditChainOrgReport[]> {
  const tailLimit = opts?.perOrgTail ?? BOOT_TAIL_LIMIT;
  let orgs: string[];
  try {
    orgs = await store.listAuditOrgs();
  } catch (err) {
    return [{ org: "*", break: null, breaks: [], epochs: [], error: `could not list audit orgs: ${String(err)}` }];
  }
  const reports: AuditChainOrgReport[] = [];
  for (const org of orgs) {
    try {
      const rows = await store.readAuditChain(org, { tailLimit });
      const walk = walkAuditChain(rows, { expectGenesis: false });
      reports.push({ org, break: walk.breaks[0] ?? null, breaks: walk.breaks, epochs: walk.epochs });
    } catch (err) {
      reports.push({ org, break: null, breaks: [], epochs: [], error: `could not read audit chain: ${String(err)}` });
    }
  }
  return reports;
}

export async function bootVerifyAuditChainTail(store: AuditChainReadable, opts?: { readonly perOrgTail?: number }): Promise<void> {
  try {
    const reports = await verifyAuditChainTail(store, opts);
    for (const r of reports) {
      if (r.error) {
        console.warn(`[open-everywhere:audit] chain tail-check could not read org "${r.org}": ${r.error}`);
        continue;
      }
      for (const e of r.epochs) {
        console.warn(
          `[open-everywhere:audit] ⚠ AUDIT CHAIN EPOCH for org "${r.org}" at seq ${e.seq} (${e.ts}): a sealed chain restart covering ` +
            `${e.seal.rowsBefore} earlier row(s) (${e.seal.breaksBefore} already broken when sealed). The seal is NOT verified from a tail ` +
            `window — run the full verifier (npm run audit:verify-chain) to check it.`,
        );
      }
      if (r.break) {
        const b = r.break;
        const more = r.breaks.length > 1 ? ` (${r.breaks.length} broken link(s) in this window; first shown)` : "";
        console.warn(
          `[open-everywhere:audit] ⚠ AUDIT CHAIN BREAK for org "${r.org}" at seq ${b.seq} (${b.ts}, action "${b.action}"): ${b.reason} ` +
            `[expected prev_sha ${b.expectedPrev ?? "null"}, found ${b.actualPrev ?? "null"}]${more} — the audit history may have been altered out of band; investigate (docs/security/audit-and-provenance.md).`,
        );
      }
    }
  } catch (err) {
    console.warn(`[open-everywhere:audit] chain tail-check failed to run (ignored — boot continues): ${String(err)}`);
  }
}
