import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { surfaceKeySegment } from "../identity/binding.js";
import { dispatchDirectMessage, type DirectMessageAction, type DirectMessageDelivery } from "./post-arms.js";
import type { DmAudienceRow } from "../operational/store.js";
import { resourceAddress } from "../access/resource-grant.js";
import { proactiveDmPlaneRow, type ProactiveDmPlane } from "./proactive-dm-manifest.js";
import { personWords, placeWords, samePerson } from "./friendly-ids.js";

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

export const DM_REFUSED_ACTION = "dm.refused";

export class ProactiveDmRefusedError extends Error {
  constructor(
    readonly plane: ProactiveDmPlane,
    readonly platform: string,
    readonly recipientId: string,
    readonly address: string,
    readonly boundary: "stopped" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

function recipientWords(platform: string, recipientId: string): string {
  const who = personWords({ id: recipientId, platform });
  return who === "someone" ? "that person" : who;
}

export function dmStoppedRefusalMessage(platform: string, recipientId: string): string {
  return (
    `${recipientWords(platform, recipientId)} asked this agent to stop sending them direct messages, so nothing ` +
    `was sent. That boundary is theirs and no configuration overrides it — only they can lift it, by telling the ` +
    `agent in their own DM. Say so plainly rather than trying another route to reach them.`
  );
}

export function dmUnreadableRefusalMessage(platform: string, recipientId: string): string {
  return (
    `nothing was sent to ${recipientWords(platform, recipientId)}: this deployment could not read whether they ` +
    `have asked the agent to stop, and it will not send a direct message it cannot check. Nobody refused you — say ` +
    `that the check itself failed, and that an operator should look at the store.`
  );
}

export async function assertProactiveDmAllowed(input: {
  readonly where: DmDeliveryWhere;
  readonly plane: ProactiveDmPlane;
  readonly platform: string;
  readonly recipientId: string;
  readonly address: string;
  readonly attributedTo?: string;
}): Promise<void> {
  proactiveDmPlaneRow(input.plane);
  const audience = await readDmAudience(input.where.org, input.address);
  if (audience.readable && !audience.stopped) return;
  const refusal = audience.readable
    ? new ProactiveDmRefusedError(
        input.plane,
        input.platform,
        input.recipientId,
        input.address,
        "stopped",
        dmStoppedRefusalMessage(input.platform, input.recipientId),
      )
    : new ProactiveDmRefusedError(
        input.plane,
        input.platform,
        input.recipientId,
        input.address,
        "unreadable",
        dmUnreadableRefusalMessage(input.platform, input.recipientId),
      );
  await auditProactiveDmRefusal(input.where, refusal, input.attributedTo);
  throw refusal;
}

async function auditProactiveDmRefusal(where: DmDeliveryWhere, refusal: ProactiveDmRefusedError, attributedTo?: string): Promise<void> {
  try {
    const foreignCaller = where.platform !== refusal.platform;
    await appendAudit({
      org: where.org,
      platform: refusal.platform,
      workspace: foreignCaller ? "unknown" : where.workspace,
      ...(where.surface === undefined ? {} : { surface: foreignCaller ? "unknown" : where.surface }),
      ...(attributedTo ? { principalId: attributedTo } : {}),
      action: DM_REFUSED_ACTION,
      detail: {
        target: refusal.recipientId,
        boundary: refusal.boundary,
        plane: refusal.plane,
        grant: refusal.address,
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] ${DM_REFUSED_ACTION} row was not written: ${String(err)}`);
  }
}

export async function deliverProactiveDm(input: {
  readonly where: DmDeliveryWhere;
  readonly plane: ProactiveDmPlane;
  readonly platform: string;
  readonly recipientId: string;
  readonly address: string;
  readonly text: string;
  readonly footer: string;
  readonly requestedBy: string;
  readonly attributedTo: string;
  readonly first?: boolean;
  readonly actions?: readonly DirectMessageAction[];
}): Promise<DirectMessageDelivery> {
  const plane = proactiveDmPlaneRow(input.plane);
  await assertProactiveDmAllowed({
    where: input.where,
    plane: input.plane,
    platform: input.platform,
    recipientId: input.recipientId,
    address: input.address,
    attributedTo: input.attributedTo,
  });
  const delivery = await dispatchDirectMessage(input.platform, {
    principalId: input.recipientId,
    text: `${input.text}${input.footer}`,
    ...(input.actions === undefined ? {} : { actions: input.actions }),
    ...(plane.generated ? { generated: true } : {}),
  });
  if (plane.recordsDelivery) await noteDmAudienceDelivery(input.where.org, input.address, new Date().toISOString());
  await appendAudit({
    org: input.where.org,
    platform: input.where.platform,
    workspace: input.where.workspace,
    ...(input.where.surface === undefined ? {} : { surface: input.where.surface }),
    principalId: input.attributedTo,
    action: DM_DELIVERY_ACTION,
    detail: {
      platform: input.platform,
      plane: input.plane,
      recipient: input.recipientId,
      grant: input.address,
      surfaceId: delivery.surfaceId,
      messageId: delivery.messageId,
      requestedBy: input.requestedBy,
      first: Boolean(input.first),
    },
  }).catch((err: unknown) => console.warn(`[open-everywhere:audit] ${DM_DELIVERY_ACTION} row was not written: ${String(err)}`));
  return delivery;
}

export interface DmDeliveryFooterInput {
  readonly platform: string;
  readonly recipientId: string;
  readonly requestedBy: string;
  readonly requesterLabel?: string;
  readonly from?: string;
  readonly fromLabel?: string;
  readonly sameConversation?: boolean;
}

export function dmDeliveryFooter(input: DmDeliveryFooterInput): string {
  if (input.sameConversation === true && samePerson(input.requestedBy, input.recipientId)) return "";
  const who = personWords({ id: input.requestedBy, platform: input.platform, reader: input.recipientId, ...(input.requesterLabel !== undefined ? { label: input.requesterLabel } : {}) });
  const where = input.from === undefined && input.fromLabel === undefined ? "" : ` in ${placeWords({ key: input.from ?? "", ...(input.fromLabel !== undefined ? { label: input.fromLabel } : {}) })}`;
  const asked = who === "you" ? "You asked for this" : `${who} asked for this`;
  return `\n\n_${asked}${where}. Reply here to ask me to stop and I will not start another DM with you._`;
}
