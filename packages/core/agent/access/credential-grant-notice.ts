import { auditErrorDetail } from "../audit/tool-action.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { canDeliverDirectMessage } from "../channels/post-arms.js";
import { assertProactiveDmAllowed, deliverProactiveDm, dmDeliveryFooter, ProactiveDmRefusedError } from "../channels/dm-audience.js";
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
import { GRANT_MODE_WORDS, grantBorrowPhrase, grantFooterPlace, grantOwnerDmAddress } from "./credential-grant-card.js";
import { personWords } from "../channels/friendly-ids.js";
import { connectorDisplayName, grantClockPhrase, grantDisplayLabel, grantOwnerPhrase, grantSpanPhrase } from "./credential-grant-copy.js";
import { grantScopeKeyIsConversationStable } from "./credential-grant-key-shape.js";
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

function grantRoomContext(): GrantRoomContext | undefined {
  return roomContext.getStore();
}

export async function resolveRequesterLabel(principalId: string): Promise<string | undefined> {
  const parsed = parsePrincipalKey(principalId);
  if (parsed === undefined) return undefined;
  const profile = await accountProfileFor(parsed.platform, parsed.id, parsed.tenant);
  return composedAccountName(profile);
}

function requesterActorPhrase(principalId: string, requesterLabel: string | undefined): string {
  const label = grantDisplayLabel(requesterLabel);
  return personWords({ id: principalId, ...(label !== undefined ? { label } : {}) });
}

export function grantRoomNoticeText(
  line: string,
  grant: Pick<CredentialGrantRow, "requesterPrincipalId" | "ownerSlug">,
  atIso: string,
  requesterLabel?: string,
): string {
  const actor = requesterActorPhrase(grant.requesterPrincipalId, requesterLabel);
  const clock = grantClockPhrase(atIso);
  const when = clock === undefined ? "Granted-credential use." : `Granted-credential use at ${clock}.`;
  return [`${when} This is ${actor}'s act, run with ${grantOwnerPhrase(grant.ownerSlug)}'s credential.`, line].join("\n");
}

export function grantOwnerNoticeText(grant: CredentialGrantRow, requesterLabel: string | undefined, nowMs: number): string {
  return [
    `Your ${connectorDisplayName(grant.connector)} credential was just used in the conversation you approved.`,
    "",
    `• What it did: ${grantBorrowPhrase(grant)}`,
    `• Who ran it: ${requesterActorPhrase(grant.requesterPrincipalId, requesterLabel)}`,
    `• The grant: ${GRANT_MODE_WORDS[grant.mode]}`,
    "",
    grant.mode === "once"
      ? "That was a one-shot grant, so it is now spent. Nothing else can be run with it."
      : `This is the FIRST use of that grant, and the only notice you get for it. It stays live ${grantSpanPhrase({ conversationStable: grantScopeKeyIsConversationStable(grant.scopeKey), expiresAt: grant.expiresAt, mode: grant.mode, nowMs })}. Tell me here to end it and I will end it now.`,
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
  const where = { org: context.org, platform: context.platform, workspace: context.workspace, ...(context.surface === undefined ? {} : { surface: context.surface }) };
  const address = grantOwnerDmAddress(ask);
  const road = {
    where,
    plane: "credential.grant.notice" as const,
    platform: ask.ownerPlatform,
    recipientId: ask.ownerNativeId,
    address,
    attributedTo: grant.requesterPrincipalId,
  };
  try {
    await assertProactiveDmAllowed(road);
  } catch (err) {
    if (err instanceof ProactiveDmRefusedError) {
      log(`owner notice for grant ${grant.id} was refused before the claim: ${err.boundary} — the grant is unchanged and the claim is unspent.`);
      return false;
    }
    throw err;
  }
  const won = await store.claimNotice(context.org, grantUseNoticeKey(grant.id), atIso);
  if (!won) return false;
  try {
    await deliverProactiveDm({
      ...road,
      text: grantOwnerNoticeText(grant, requesterLabel, Date.parse(atIso)),
      footer: dmDeliveryFooter({
        platform: ask.ownerPlatform,
        recipientId: ask.ownerNativeId,
        requestedBy: grant.requesterPrincipalId,
        ...(grantDisplayLabel(requesterLabel) !== undefined ? { requesterLabel: grantDisplayLabel(requesterLabel) } : {}),
        ...grantFooterPlace(grant.scopeKey, undefined),
      }),
      requestedBy: grant.requesterPrincipalId,
      attributedTo: grant.requesterPrincipalId,
    });
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
      ...(err === undefined ? {} : { error: auditErrorDetail(err instanceof Error ? err.name : "unknown").error }),
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
