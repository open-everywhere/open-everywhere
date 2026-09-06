import { AsyncLocalStorage } from "node:async_hooks";
import { canDeliverDirectMessage, postArm } from "../channels/post-arms.js";
import { postReply, resolveReplyTarget } from "../channels/reply-post.js";
import type { BindableContext } from "../identity/binding.js";
import { accountProfileFor, composedAccountName } from "../identity/account-display-name.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import type { CredentialGrantRow } from "../operational/credential-grant-rows.js";
import {
  foreignGrantRoomNoticeRegistrant,
  GrantRoomNoticeAlreadyRegisteredError,
  registerCoreGrantRoomNotice,
} from "./grant-room-notice-registry.internal.js";
import { GRANT_MODE_WORDS } from "./credential-grant-card.js";
import { auditGrant, type GrantAuditStamps } from "./credential-grant-flow.js";

function log(line: string): void {
  console.log(`[open-everywhere:grant] ${line}`);
}

export interface GrantRoomContext extends GrantAuditStamps {
  readonly ctx: BindableContext;
}

const roomContext = new AsyncLocalStorage<GrantRoomContext>();

export function withGrantRoomContext<T>(context: GrantRoomContext, fn: () => Promise<T>): Promise<T> {
  return roomContext.run(context, fn);
}

export function grantRoomContext(): GrantRoomContext | undefined {
  return roomContext.getStore();
}

export async function resolveRequesterLabel(principalId: string): Promise<string | undefined> {
  const parsed = parsePrincipalKey(principalId);
  if (parsed === undefined) return undefined;
  const profile = await accountProfileFor(parsed.platform, parsed.id, parsed.tenant);
  return composedAccountName(profile);
}

function requesterActorPhrase(principalId: string, requesterLabel: string | undefined): string {
  return requesterLabel ? `${requesterLabel} (\`${principalId}\`)` : `\`${principalId}\``;
}

export function grantRoomNoticeText(
  line: string,
  grant: Pick<CredentialGrantRow, "requesterPrincipalId" | "ownerSlug">,
  atIso: string,
  requesterLabel?: string,
): string {
  const actor = requesterActorPhrase(grant.requesterPrincipalId, requesterLabel);
  return [`Granted-credential use at ${atIso}. This is ${actor}'s act, run with ${grant.ownerSlug}'s credential.`, line].join("\n");
}

export function grantOwnerNoticeText(grant: CredentialGrantRow, requesterLabel?: string): string {
  return [
    `Your ${grant.connector} credential was just used in the conversation you approved.`,
    "",
    `• Tool: \`${grant.verb}\``,
    `• Resource: \`${grant.resource}\``,
    `• Who ran it: ${requesterActorPhrase(grant.requesterPrincipalId, requesterLabel)}`,
    `• Grant: \`${grant.id}\` (${GRANT_MODE_WORDS[grant.mode]})`,
    "",
    grant.mode === "once"
      ? "That was a one-shot grant, so it is now spent. Nothing else can be run with it."
      : `This is the FIRST use of that grant, and the only notice you get for it. It stays live until ${grant.expiresAt} unless you revoke it.`,
  ].join("\n");
}

export function grantUseNoticeKey(grantId: string): string {
  return `grant-use:${grantId}`;
}

export async function postGrantRoomNotice(
  context: GrantRoomContext | undefined,
  line: string,
  grant: CredentialGrantRow,
  atIso: string,
  requesterLabel?: string,
): Promise<boolean> {
  if (context === undefined) return false;
  const target = resolveReplyTarget(context.ctx);
  if (target === null) return false;
  await postReply(target, grantRoomNoticeText(line, grant, atIso, requesterLabel));
  return true;
}

export async function deliverGrantOwnerNotice(
  context: GrantRoomContext | undefined,
  grant: CredentialGrantRow,
  atIso: string,
  requesterLabel?: string,
): Promise<boolean> {
  if (context === undefined) return false;
  const store = getOperationalStore();
  const ask = await store.getCredentialGrantAsk(context.org, grant.askId);
  if (ask === null) return false;
  if (!canDeliverDirectMessage(ask.ownerPlatform)) return false;
  const arm = postArm(ask.ownerPlatform);
  const deliver = arm?.deliverDirectMessage;
  if (deliver === undefined || arm === undefined) return false;
  const won = await store.claimNotice(context.org, grantUseNoticeKey(grant.id), atIso);
  if (!won) return false;
  try {
    await deliver.call(arm, { principalId: ask.ownerNativeId, text: grantOwnerNoticeText(grant, requesterLabel) });
  } catch (err) {
    await auditOwnerNotice(context, grant, ask.ownerPlatform, "failed", err);
    throw err;
  }
  await auditOwnerNotice(context, grant, ask.ownerPlatform, "sent");
  return true;
}

async function auditOwnerNotice(
  stamps: GrantAuditStamps,
  grant: CredentialGrantRow,
  ownerPlatform: string,
  outcome: "sent" | "failed",
  err?: unknown,
): Promise<void> {
  try {
    await auditGrant(stamps, "grant.notified", grant.ownerPrincipalId, {
      connector: grant.connector,
      grantId: grant.id,
      mode: grant.mode,
      outcome,
      owner: grant.ownerPrincipalId,
      ownerPlatform,
      requester: grant.requesterPrincipalId,
      verb: grant.verb,
      ...(err === undefined ? {} : { error: err instanceof Error ? err.name : "unknown" }),
    });
  } catch (auditErr) {
    log(`grant.notified row was not written for grant ${grant.id}: ${String(auditErr)}`);
  }
}

export function installGrantUseNotices(): void {
  const foreign = foreignGrantRoomNoticeRegistrant();
  if (foreign !== undefined) throw new GrantRoomNoticeAlreadyRegisteredError(foreign);
  registerCoreGrantRoomNotice(async (line, grant) => {
    const context = grantRoomContext();
    const atIso = new Date().toISOString();
    const requesterLabel = await resolveRequesterLabel(grant.requesterPrincipalId).catch(() => undefined);
    const [room, owner] = await Promise.allSettled([
      postGrantRoomNotice(context, line, grant, atIso, requesterLabel),
      deliverGrantOwnerNotice(context, grant, atIso, requesterLabel),
    ]);
    if (room.status === "rejected") log(`room notice could not be posted for grant ${grant.id}: ${String(room.reason)}`);
    if (owner.status === "rejected") log(`owner notice could not be delivered for grant ${grant.id}: ${String(owner.reason)}`);
    if (room.status === "rejected") return { posted: false, reason: "post_failed" };
    if (!room.value) return { posted: false, reason: context === undefined ? "no_room_context" : "no_post_arm" };
    return { posted: true };
  });
}
