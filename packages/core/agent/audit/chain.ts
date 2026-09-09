import { createHash } from "node:crypto";
import type { AuditChainRow } from "../operational/store.js";

export interface HashableAuditRow {
  readonly org: string;
  readonly ts: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
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
  const canonical = JSON.stringify([
    prevSha,
    row.org,
    row.ts,
    row.platform,
    row.workspace,
    row.surface ?? null,
    row.principalId ?? null,
    row.action,
    row.detail === undefined ? null : stableStringify(row.detail),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
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
  if (rows.length === 0) return null;
  const first = rows[0];
  if ((opts?.expectGenesis ?? false) && first.prevSha !== null) {
    return {
      index: 0,
      seq: first.seq,
      ts: first.ts,
      org: first.org,
      action: first.action,
      reason: "genesis row carries a non-null prev_sha (rows before it were removed, or the chain was reset)",
      expectedPrev: null,
      actualPrev: first.prevSha,
    };
  }
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const expected = auditRowSha(prev, prev.prevSha);
    if (cur.prevSha !== expected) {
      return {
        index: i,
        seq: cur.seq,
        ts: cur.ts,
        org: cur.org,
        action: cur.action,
        reason:
          cur.prevSha === null
            ? "prev_sha is null mid-chain (a row's link was cleared — truncation/reset)"
            : "prev_sha does not match the recomputed hash of the preceding row (the predecessor was mutated or a row between them was deleted)",
        expectedPrev: expected,
        actualPrev: cur.prevSha,
      };
    }
  }
  return null;
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
    return [{ org: "*", break: null, error: `could not list audit orgs: ${String(err)}` }];
  }
  const reports: AuditChainOrgReport[] = [];
  for (const org of orgs) {
    try {
      const rows = await store.readAuditChain(org, { tailLimit });
      reports.push({ org, break: findChainBreak(rows, { expectGenesis: false }) });
    } catch (err) {
      reports.push({ org, break: null, error: `could not read audit chain: ${String(err)}` });
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
      } else if (r.break) {
        const b = r.break;
        console.warn(
          `[open-everywhere:audit] ⚠ AUDIT CHAIN BREAK for org "${r.org}" at seq ${b.seq} (${b.ts}, action "${b.action}"): ${b.reason} ` +
            `[expected prev_sha ${b.expectedPrev ?? "null"}, found ${b.actualPrev ?? "null"}] — the audit history may have been altered out of band; investigate (docs/security/audit-and-provenance.md).`,
        );
      }
    }
  } catch (err) {
    console.warn(`[open-everywhere:audit] chain tail-check failed to run (ignored — boot continues): ${String(err)}`);
  }
}
