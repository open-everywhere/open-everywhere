import { getOperationalStore } from "../operational/provider.js";
import type { AuditEntry, AuditInput, AuditFilter } from "../operational/store.js";

export type { AuditEntry, AuditInput, AuditFilter } from "../operational/store.js";

export async function appendAudit(entry: AuditInput): Promise<void> {
  const record: AuditEntry = { ...entry, ts: entry.ts ?? new Date().toISOString() };
  try {
    await getOperationalStore().appendAudit(record);
  } catch (err) {
    console.warn(`[open-everywhere:audit] dropped a "${record.action}" entry for ${record.org}/${record.platform}/${record.workspace}: ${String(err)}`);
  }
}

export async function readAudit(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  return getOperationalStore().readAudit(filter);
}

export function auditRoot(): string {
  return getOperationalStore().root();
}
