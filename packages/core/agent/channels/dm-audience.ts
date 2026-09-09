import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { surfaceKeySegment } from "../identity/binding.js";
import { dispatchDirectMessage, type DirectMessageDelivery } from "./post-arms.js";
import type { DmAudienceRow } from "../operational/store.js";
import { resourceAddress } from "../access/resource-grant.js";

export const PERSON_RESOURCE_TYPE = "person";

export function personAddress(platform: string, principalId: string): string {
  return resourceAddress(platform, PERSON_RESOURCE_TYPE, surfaceKeySegment(principalId));
}

export const DM_STOP_ACTION = "dm.audience.stopped";

export const DM_RESUME_ACTION = "dm.audience.resumed";

export interface DmAudienceState {
  readonly stopped: boolean;
  readonly delivered: boolean;
  readonly readable: boolean;
  readonly row: DmAudienceRow | null;
}

export async function readDmAudience(org: string, address: string): Promise<DmAudienceState> {
  try {
    const row = await getOperationalStore().getDmAudience(org, address);
    return { stopped: row?.stoppedAt !== undefined, delivered: row?.firstDmAt !== undefined, readable: true, row };
  } catch (err) {
    console.warn(`[open-everywhere:dm-audience] getDmAudience failed (${address}): ${String(err)} — suppressing this delivery`);
    return { stopped: true, delivered: false, readable: false, row: null };
  }
}

export async function noteDmAudienceDelivery(org: string, address: string, at: string): Promise<void> {
  try {
    await getOperationalStore().markDmAudienceDelivered(org, address, at);
  } catch (err) {
    console.warn(`[open-everywhere:dm-audience] markDmAudienceDelivered failed (${address}): ${String(err)}`);
  }
}

export interface DmAudienceChange {
  readonly changed: boolean;
}

export async function stopDmAudience(input: {
  readonly org: string;
  readonly address: string;
  readonly at: string;
  readonly platform: string;
  readonly workspace: string;
  readonly principalId: string;
}): Promise<DmAudienceChange> {
  const before = await getOperationalStore().getDmAudience(input.org, input.address);
  await getOperationalStore().setDmAudienceStopped(input.org, input.address, input.at);
  const changed = before?.stoppedAt === undefined;
  await noteAudienceChange(DM_STOP_ACTION, input, changed);
  return { changed };
}

export async function resumeDmAudience(input: {
  readonly org: string;
  readonly address: string;
  readonly platform: string;
  readonly workspace: string;
  readonly principalId: string;
}): Promise<DmAudienceChange> {
  const changed = await getOperationalStore().clearDmAudienceStopped(input.org, input.address);
  await noteAudienceChange(DM_RESUME_ACTION, input, changed);
  return { changed };
}

async function noteAudienceChange(
  action: string,
  input: { readonly org: string; readonly address: string; readonly platform: string; readonly workspace: string; readonly principalId: string },
  changed: boolean,
): Promise<void> {
  try {
    await appendAudit({
      org: input.org,
      platform: input.platform,
      workspace: input.workspace || "unknown",
      principalId: input.principalId,
      action,
      detail: { address: input.address, changed },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] ${action} row was not written: ${String(err)}`);
  }
}

const DM_DELIVERY_ACTION = "chat.dm";

export interface DmDeliveryWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
}

export async function deliverProactiveDm(input: {
  readonly where: DmDeliveryWhere;
  readonly platform: string;
  readonly recipientId: string;
  readonly address: string;
  readonly text: string;
  readonly footer: string;
  readonly requestedBy: string;
  readonly attributedTo: string;
  readonly first: boolean;
  readonly tainted?: boolean;
}): Promise<DirectMessageDelivery> {
  const delivery = await dispatchDirectMessage(input.platform, {
    principalId: input.recipientId,
    text: `${input.text}${input.footer}`,
  });
  await noteDmAudienceDelivery(input.where.org, input.address, new Date().toISOString());
  await appendAudit({
    org: input.where.org,
    platform: input.where.platform,
    workspace: input.where.workspace,
    ...(input.where.surface === undefined ? {} : { surface: input.where.surface }),
    principalId: input.attributedTo,
    action: DM_DELIVERY_ACTION,
    detail: {
      platform: input.platform,
      recipient: input.recipientId,
      grant: input.address,
      surfaceId: delivery.surfaceId,
      messageId: delivery.messageId,
      requestedBy: input.requestedBy,
      first: input.first,
      tainted: Boolean(input.tainted),
    },
  }).catch((err: unknown) => console.warn(`[open-everywhere:audit] ${DM_DELIVERY_ACTION} row was not written: ${String(err)}`));
  return delivery;
}

export function dmDeliveryFooter(input: { readonly requestedBy: string; readonly fromContainer: string }): string {
  return (
    `\n\n_Sent by the agent on behalf of ${input.requestedBy}, from ${input.fromContainer}. ` +
    `Reply here to ask me to stop and I will not start another DM with you._`
  );
}
