import { AsyncLocalStorage } from "node:async_hooks";
import { canDeliverDirectMessage, postArm } from "../channels/post-arms.js";
import { postReply, resolveReplyTarget } from "../channels/reply-post.js";
import type { BindableContext } from "../identity/binding.js";
import { accountProfileFor, composedAccountName } from "../identity/account-display-name.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import type { CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { registerGrantRoomNotice } from "./credential-grant-broker.js";

function log(line: string): void {
  console.log(`[open-everywhere:grant] ${line}`);
}

export interface GrantRoomContext {
  readonly ctx: BindableContext;
  readonly org: string;
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
    `• Grant: \`${grant.id}\` (${grant.mode})`,
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
  await deliver.call(arm, { principalId: ask.ownerNativeId, text: grantOwnerNoticeText(grant, requesterLabel) });
  return true;
}

export function installGrantUseNotices(): void {
  registerGrantRoomNotice(async (line, grant) => {
    const context = grantRoomContext();
    const atIso = new Date().toISOString();
    const requesterLabel = await resolveRequesterLabel(grant.requesterPrincipalId).catch(() => undefined);
    const [room, owner] = await Promise.allSettled([
      postGrantRoomNotice(context, line, grant, atIso, requesterLabel),
      deliverGrantOwnerNotice(context, grant, atIso, requesterLabel),
    ]);
    if (room.status === "rejected") log(`room notice could not be posted for grant ${grant.id}: ${String(room.reason)}`);
    if (owner.status === "rejected") log(`owner notice could not be delivered for grant ${grant.id}: ${String(owner.reason)}`);
  });
}
