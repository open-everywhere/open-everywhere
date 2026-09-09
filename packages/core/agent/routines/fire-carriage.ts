import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { routinePartition } from "./partition.js";
import type { Routine } from "./routine.js";

export const FIRE_ATTRS_SENT_ACTION = "routine.fire_attrs_sent";
export const FIRE_ATTRS_SEEN_ACTION = "routine.fire_attrs_seen";

function attributeKeyNames(attributes: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return Object.keys(attributes ?? {}).sort();
}

export async function auditFireAttrsSent(
  routine: Routine,
  attributes: Readonly<Record<string, unknown>> | undefined,
  wakeId: string,
): Promise<void> {
  try {
    const p = routinePartition(routine);
    const attrKeys = attributeKeyNames(attributes);
    await appendAudit({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      action: FIRE_ATTRS_SENT_ACTION,
      detail: { routineId: routine.id, wakeId, attrKeys: [...attrKeys], attrCount: attrKeys.length },
    });
  } catch {
  }
}

export async function auditFireAttrsSeen(
  where: { readonly platform: string; readonly workspace: string; readonly surface: string },
  attributes: Readonly<Record<string, unknown>> | undefined,
  sessionId: string | undefined,
): Promise<void> {
  try {
    const attrKeys = attributeKeyNames(attributes);
    await appendAudit({
      org: deploymentOrg(),
      platform: where.platform,
      workspace: where.workspace,
      surface: where.surface,
      action: FIRE_ATTRS_SEEN_ACTION,
      detail: { attrKeys: [...attrKeys], attrCount: attrKeys.length, sessionId: sessionId ?? null },
    });
  } catch {
  }
}
