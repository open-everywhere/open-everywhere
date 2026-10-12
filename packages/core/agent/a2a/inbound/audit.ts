import { appendAudit, type AuditInput } from "../../audit/audit.js";
import { A2A_INBOUND_PLATFORM, A2A_INBOUND_WORKSPACE } from "./declaration.js";
import { A2A_INBOUND_REFUSED_ACTION, type A2aInboundAuditRow } from "./handler.js";

const A2A_INBOUND_REFUSAL_WINDOW_MS = 60_000;

const suppressed = new Map<string, number>();

export function resetA2aInboundRefusalThrottle(): void {
  suppressed.clear();
}

export interface A2aInboundAuditDeps {
  readonly org: string;
  readonly markSeen: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly append?: (entry: AuditInput) => Promise<void>;
  readonly now?: () => Date;
}

export function a2aInboundAuditor(deps: A2aInboundAuditDeps): (row: A2aInboundAuditRow) => Promise<void> {
  const append = deps.append ?? appendAudit;
  return async (row) => {
    let carried = 0;
    if (row.action === A2A_INBOUND_REFUSED_ACTION) {
      const key = `a2a-inbound-refused:${String(row.detail["reason"])}`;
      let first = true;
      try {
        first = await deps.markSeen(deps.org, key, (deps.now?.() ?? new Date()).toISOString(), A2A_INBOUND_REFUSAL_WINDOW_MS);
      } catch {
        first = true;
      }
      if (!first) {
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
        return;
      }
      carried = suppressed.get(key) ?? 0;
      suppressed.delete(key);
    }
    await append({
      org: deps.org,
      platform: A2A_INBOUND_PLATFORM,
      workspace: A2A_INBOUND_WORKSPACE,
      surface: row.caller ?? "-",
      ...(row.caller !== undefined ? { principalId: `a2a:${row.caller}` } : {}),
      action: row.action,
      detail: { ...row.detail, ...(carried > 0 ? { suppressed: carried, windowMs: A2A_INBOUND_REFUSAL_WINDOW_MS } : {}) },
    }).catch(() => undefined);
  };
}
