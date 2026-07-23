import { getOperationalStore } from "../operational/provider.js";
import { withOrgAuditLock } from "./chain.js";
import type { AuditEntry, AuditInput, AuditFilter } from "../operational/store.js";

export type { AuditEntry, AuditInput, AuditFilter } from "../operational/store.js";

let auditDropCounter: ((action: string, platform: string) => void) | null = null;
export function registerAuditDropCounter(fn: (action: string, platform: string) => void): void {
  auditDropCounter = fn;
}

export async function appendAudit(entry: AuditInput): Promise<void> {
  const record: AuditEntry = { ...entry, ts: entry.ts ?? new Date().toISOString() };
  return withOrgAuditLock(record.org, async () => {
  try {
    await getOperationalStore().appendAudit(record);
  } catch (firstErr) {
    try {
      await getOperationalStore().appendAudit(record);
    } catch (secondErr) {
      try {
        auditDropCounter?.(record.action, record.platform);
      } catch {
      }
      console.warn(`[open-everywhere:audit] dropped a "${record.action}" entry for ${record.org}/${record.platform}/${record.workspace} after one retry: ${String(secondErr)} (first: ${String(firstErr)})`);
    }
  }
  });
}

export function auditSilencesEnabled(): boolean {
  return process.env.OE_AUDIT_SILENCES === "1";
}

export async function readAudit(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  return getOperationalStore().readAudit(filter);
}

export function auditRoot(): string {
  return getOperationalStore().root();
}
