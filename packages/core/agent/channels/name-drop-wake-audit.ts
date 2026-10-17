import { appendAudit } from "../audit/audit.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const NAME_DROP_WOKE_ACTION = "surface.name_drop_woke";

export const NAME_DROP_SILENT_ACTION = "surface.name_drop_silent";

export type NameDropRoad = "seat" | "native";

export type NameDropVia = "built-in" | "arm";

export interface NameDropAuditKey {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly container: string;
  readonly ts: string | null;
}

export type NameDropAuditAppend = (entry: {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail: AuditDetail;
}) => Promise<void>;

export function nameDropAuditRow(
  key: NameDropAuditKey,
  action: string,
  reason: string,
  extra: AuditDetail = {},
): {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail: AuditDetail;
} {
  return {
    org: key.org,
    platform: key.platform,
    workspace: key.workspace,
    ...(key.surface === undefined ? {} : { surface: key.surface }),
    ...(key.principalId === undefined ? {} : { principalId: key.principalId }),
    action,
    detail: { reason, container: key.container, ts: key.ts, ...extra },
  };
}

export async function auditNameDropWoke(
  key: NameDropAuditKey,
  reason: string,
  opts: { readonly road: NameDropRoad; readonly via: NameDropVia; readonly append?: NameDropAuditAppend },
): Promise<void> {
  const append = opts.append ?? ((e) => appendAudit(e));
  try {
    await append(nameDropAuditRow(key, NAME_DROP_WOKE_ACTION, reason, { road: opts.road, via: opts.via }));
  } catch {
  }
}

export async function auditNameDropSilent(
  key: NameDropAuditKey,
  reason: string,
  opts: { readonly append?: NameDropAuditAppend } = {},
): Promise<void> {
  const append = opts.append ?? ((e) => appendAudit(e));
  try {
    await append(nameDropAuditRow(key, NAME_DROP_SILENT_ACTION, reason));
  } catch {
  }
}
