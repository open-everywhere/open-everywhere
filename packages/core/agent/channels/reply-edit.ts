import { appendAudit } from "../audit/audit.js";
import { onVercel } from "../access/platform.js";
import { postArm } from "./post-arms.js";
import { isOwnPost, type OwnPostLedgerDeps } from "./own-post-ledger.js";
import type { ReplyAudit } from "./reply-post.js";

export interface EditLocus {
  readonly platform: string;
  readonly channelId: string;
  readonly serviceUrl?: string;
}

export const EDIT_NOT_OWN_REFUSAL_REASON = "not-own-post";

export const EDIT_NO_ARM_REFUSAL_REASON = "no-edit-arm";

export function editRefusalMessage(reason: string): string {
  if (reason === EDIT_NO_ARM_REFUSAL_REASON) {
    return "edit_reply can't edit a message on this surface — no edit primitive is wired here. Post a new `reply` with the correction instead.";
  }
  return (
    "edit_reply refused: that message id is not one of your own recent posts in this conversation. " +
    "You can only edit a message YOU posted here with `reply`, and only for a few hours after posting. " +
    "Post a new `reply` with the correction instead."
  );
}

export async function auditReplyEditRefused(audit: ReplyAudit | undefined, reason: string): Promise<void> {
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
      ...(audit.wakeId ? { wakeId: audit.wakeId.slice(0, 200) } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

export async function auditReplyEdit(audit: ReplyAudit | undefined, id: string, platform: string, chars: number): Promise<void> {
  if (!audit) return;
  await appendAudit({
    org: audit.org,
    platform: audit.platform,
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
  const arm = postArm(locus.platform);
  if (!arm?.editMessage) {
    await auditReplyEditRefused(audit, EDIT_NO_ARM_REFUSAL_REASON);
    throw new Error(editRefusalMessage(EDIT_NO_ARM_REFUSAL_REASON));
  }
  if (!(await isOwnPost(audit.org, locus, messageId, ledgerDeps))) {
    await auditReplyEditRefused(audit, EDIT_NOT_OWN_REFUSAL_REASON);
    throw new Error(editRefusalMessage(EDIT_NOT_OWN_REFUSAL_REASON));
  }
  if (process.env.OE_EGRESS_SPOOF === "1") {
    if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed a ${locus.platform} edit (${text.length}c)`);
    await auditReplyEdit(audit, messageId, locus.platform, text.length);
    return;
  }
  await arm.editMessage(locus, messageId, text);
  await auditReplyEdit(audit, messageId, locus.platform, text.length);
}
