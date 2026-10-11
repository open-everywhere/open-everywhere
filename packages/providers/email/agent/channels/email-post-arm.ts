import {
  emailPolicy,
  emailTransport,
  findEmailInbox,
  getConfig,
  markNotApplied,
  mayReceiveReply,
  type EmailPolicy,
  type EmailTransport,
  type PostArm,
  type UnifiedReplyDeps,
  type UnifiedWakeOrigin,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { Principal } from "@open-everywhere/core/agent/adapter-api.js";
import { emailWakeOriginCodec } from "./email-origin-codec.js";

type EmailOrigin = Extract<UnifiedWakeOrigin, { platform: "email" }>;

const EMAIL_REPLY_MAX_CHARS = 50_000;

export interface EmailPostDeps {
  readonly policy?: () => EmailPolicy;
  readonly principals?: () => readonly Principal[];
  readonly transport?: (id: string) => EmailTransport | undefined;
}

function livePrincipals(): readonly Principal[] {
  try {
    return getConfig().loadPrincipals?.() ?? [];
  } catch {
    return [];
  }
}

export async function sendEmailReply(origin: EmailOrigin, text: string, deps: EmailPostDeps = {}): Promise<string> {
  if (!emailWakeOriginCodec.validate(origin as unknown as Record<string, unknown>)) {
    throw markNotApplied(new Error("reply couldn't send the email — the stored reply target is not a valid email origin."));
  }
  const policy = (deps.policy ?? emailPolicy)();
  if (!policy.enabled) throw markNotApplied(new Error("reply couldn't send the email — the email surface is turned off in agent/email/policy.ts."));
  const inbox = findEmailInbox(policy, origin.inbox);
  if (!inbox) throw markNotApplied(new Error(`reply couldn't send the email — ${origin.inbox} is no longer one of this deployment's inboxes.`));
  const transport = (deps.transport ?? emailTransport)(policy.transport);
  if (!transport) throw markNotApplied(new Error(`reply couldn't send the email — no email transport "${policy.transport}" is registered.`));
  const principals = (deps.principals ?? livePrincipals)();
  const allowed = (a: string): boolean => mayReceiveReply(policy, inbox, principals, a);
  const to = origin.to.filter(allowed);
  if (to.length === 0) {
    throw markNotApplied(new Error("reply couldn't send the email — the person who wrote may no longer receive mail from this inbox (the sender list changed)."));
  }
  const cc = (origin.cc ?? []).filter(allowed).slice(0, Math.max(0, policy.maxRecipients - to.length));
  const body = text.length > EMAIL_REPLY_MAX_CHARS ? `${text.slice(0, EMAIL_REPLY_MAX_CHARS)}\n\n[… this reply was cut at ${EMAIL_REPLY_MAX_CHARS} characters]` : text;
  const sent = await transport.reply({ inbox: origin.inbox, inReplyToMessageId: origin.messageId, to, cc, text: body });
  return sent.messageId;
}

export const emailPostArm: PostArm = {
  platform: "email",
  dispatchUnified: (origin, text, _deps: UnifiedReplyDeps) => sendEmailReply(origin as EmailOrigin, text),
  describeRedriveTarget: (origin) => `email thread ${(origin as EmailOrigin).threadId} in ${(origin as EmailOrigin).inbox}`,
  redriveContainerId: (origin) => (origin as EmailOrigin).threadId,
};
