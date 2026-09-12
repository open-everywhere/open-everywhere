import { appendAudit } from "../audit/audit.js";
import { swallowRoomOp } from "./egress-spoof.js";
import { postArm } from "./post-arms.js";
import { isOwnPost, type OwnPostLedgerDeps } from "./own-post-ledger.js";
import { markNotApplied, platformFailureClass, platformFailureStatus, type PlatformFailureClass } from "./platform-failure.js";
import { truncateMemoryCitationPaths } from "./turn-delivery.js";
import { applyReplyProvenance, auditReplyProvenance } from "./reply-provenance.js";
import type { ReplyAudit } from "./reply-post.js";

export interface EditLocus {
  readonly platform: string;
  readonly channelId: string;
  readonly serviceUrl?: string;
  readonly organizationId?: string;
}

export const EDIT_NOT_OWN_REFUSAL_REASON = "not-own-post";

export const EDIT_NO_ARM_REFUSAL_REASON = "no-edit-arm";

export const EDIT_PLATFORM_ERROR_REASON = "platform-error";

export function ambiguousEditNote(platform: string): string {
  const where = platform && platform.length > 0 ? platform : "the surface";
  return (
    `The edit was sent but ${where} did not confirm it, so the message may or may not have changed. ` +
    "Do NOT post a new reply about it — if the edit did land, a fresh post says the same thing twice. " +
    "Call `edit_reply` again with the same message id if the correction matters; repeating an edit is safe."
  );
}

export function editRefusalMessage(reason: string, platform?: string): string {
  if (reason === EDIT_NO_ARM_REFUSAL_REASON) {
    const where = platform && platform.length > 0 ? platform : "this surface";
    return (
      `edit_reply can't edit a message on ${where} — that surface has no API for editing the agent's own posts, so nothing here can be edited. ` +
      `Post a new \`reply\` with the correction instead, and say in it that it replaces the earlier message and that ${where} cannot edit a posted message. ` +
      "Otherwise the room is left with two versions and no way to tell which one is current."
    );
  }
  return (
    "edit_reply refused: that message id is not one of your own recent posts in this conversation. " +
    "You can only edit a message YOU posted here with `reply`, and only for a few hours after posting. " +
    "Post a new `reply` with the correction instead, and say in it that it replaces the earlier message and that the original could not be edited. " +
    "Otherwise the room is left with two versions and no way to tell which one is current."
  );
}

export async function auditReplyEditRefused(
  audit: ReplyAudit | undefined,
  reason: string,
  status?: number,
  failure?: PlatformFailureClass,
): Promise<void> {
  if (!audit) return;
  await appendAudit({
    org: audit.org,
    platform: audit.platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: "reply.edit.refused",
    detail: {
      reason,
      route: audit.route,
      ...(status !== undefined ? { status } : {}),
      ...(failure !== undefined ? { failure } : {}),
      ...(audit.wakeId ? { wakeId: audit.wakeId.slice(0, 200) } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

async function auditReplyEdit(audit: ReplyAudit | undefined, id: string, platform: string, chars: number): Promise<void> {
  if (!audit) return;
  await appendAudit({
    org: audit.org,
    platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: "reply.edit",
    detail: {
      id,
      platform,
      chars,
      route: audit.route,
      ...(audit.creatorId ? { creatorId: audit.creatorId } : {}),
      ...(audit.wakeId ? { wakeId: audit.wakeId } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

export async function editPostedMessage(
  locus: EditLocus,
  messageId: string,
  text: string,
  audit: ReplyAudit,
  ledgerDeps: OwnPostLedgerDeps = {},
): Promise<void> {
  const provenance = applyReplyProvenance(truncateMemoryCitationPaths(text), audit);
  text = provenance.body;
  const arm = postArm(locus.platform);
  if (!arm?.editMessage) {
    await auditReplyEditRefused(audit, EDIT_NO_ARM_REFUSAL_REASON);
    throw markNotApplied(new Error(editRefusalMessage(EDIT_NO_ARM_REFUSAL_REASON, locus.platform)));
  }
  if (!(await isOwnPost(audit.org, locus, messageId, ledgerDeps))) {
    await auditReplyEditRefused(audit, EDIT_NOT_OWN_REFUSAL_REASON);
    throw markNotApplied(new Error(editRefusalMessage(EDIT_NOT_OWN_REFUSAL_REASON)));
  }
  if (swallowRoomOp(`a ${locus.platform} edit (${text.length}c)`)) {
    await auditReplyEdit(audit, messageId, locus.platform, text.length);
    await auditReplyProvenance(audit, messageId, locus.platform, provenance.reads, provenance.shown);
    return;
  }
  try {
    await arm.editMessage(locus, messageId, text);
  } catch (err) {
    await auditReplyEditRefused(audit, EDIT_PLATFORM_ERROR_REASON, platformFailureStatus(err), platformFailureClass(err));
    throw err;
  }
  await auditReplyEdit(audit, messageId, locus.platform, text.length);
  await auditReplyProvenance(audit, messageId, locus.platform, provenance.reads, provenance.shown);
}
