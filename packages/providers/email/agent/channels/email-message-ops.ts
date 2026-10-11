import {
  emailPolicy,
  emailTransport,
  findEmailInbox,
  getConfig,
  markNotApplied,
  mayReceiveReply,
  parseMailbox,
  parseMailboxList,
  type EmailPolicy,
  type EmailTransport,
  type Principal,
  type SurfaceMessageOps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { parseEmailThreadAddress } from "./email-identity.js";

export interface EmailMessageOpsDeps {
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

export async function postEmailThreadNotice(channelId: string, text: string, deps: EmailMessageOpsDeps = {}): Promise<string> {
  const addr = parseEmailThreadAddress(channelId);
  if (!addr) throw markNotApplied(new Error("an email notice needs a `<inbox>/<thread>` address."));
  const policy = (deps.policy ?? emailPolicy)();
  if (!policy.enabled) throw markNotApplied(new Error("the email surface is turned off."));
  const inbox = findEmailInbox(policy, addr.inbox);
  if (!inbox) throw markNotApplied(new Error(`${addr.inbox} is not one of this deployment's inboxes.`));
  const transport = (deps.transport ?? emailTransport)(policy.transport);
  if (!transport?.readThread) throw markNotApplied(new Error(`the email transport "${policy.transport}" cannot read a thread, so a notice has no recipients.`));
  const principals = (deps.principals ?? livePrincipals)();
  const allowed = (a: string): boolean => mayReceiveReply(policy, inbox, principals, a);
  const msgs = (await transport.readThread(inbox.address, addr.threadId, 50)).filter((m) => m.suspect !== true);
  const latest = [...msgs].reverse().find((m) => m.sent !== true && parseMailbox(m.from)?.address !== inbox.address);
  if (!latest) throw markNotApplied(new Error("the email thread has no message from anybody but the agent, so a notice has nobody to answer."));
  const sender = parseMailbox(latest.from)?.address;
  if (inbox.kind === "personal") {
    const people = new Set(msgs.filter((m) => m.sent !== true).map((m) => parseMailbox(m.from)?.address ?? "").filter((a) => a !== inbox.address));
    if (people.size !== 1 || sender === undefined || !people.has(sender) || !allowed(sender)) {
      throw markNotApplied(new Error("this personal-inbox thread does not name exactly one person who may receive mail, so no notice was sent."));
    }
    const sentOne = await transport.reply({ inbox: inbox.address, inReplyToMessageId: latest.messageId, to: [sender], cc: [], text });
    return sentOne.messageId;
  }
  const participants = [
    ...new Set(msgs.flatMap((m) => parseMailboxList([m.from, ...(m.to ?? []), ...(m.cc ?? [])]).map((x) => x.address))),
  ].filter((a) => a !== inbox.address && allowed(a));
  const primary = sender !== undefined && participants.includes(sender) ? sender : participants[0];
  if (primary === undefined) throw markNotApplied(new Error("nobody on the email thread may receive mail from this inbox, so no notice was sent."));
  const cc = participants.filter((a) => a !== primary).slice(0, Math.max(0, policy.maxRecipients - 1));
  const sent = await transport.reply({ inbox: inbox.address, inReplyToMessageId: latest.messageId, to: [primary], cc, text });
  return sent.messageId;
}

export const emailMessageOps: SurfaceMessageOps = {
  platform: "email",
  postText: (channelId, text) => postEmailThreadNotice(channelId, text),
  async editMessage() {
    throw markNotApplied(new Error("a sent email cannot be edited."));
  },
};
