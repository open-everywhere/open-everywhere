import { createHash } from "node:crypto";
import {
  emailDomainOf,
  emailPolicy,
  findEmailInbox,
  emailTransport,
  normalizeEmailAddress,
  parseMailbox,
  parseMailboxList,
  type BindableContext,
  type EmailThreadMessage,
  type ReadAdapter,
  type RenderedLine,
  type WakeReadAddress,
} from "@open-everywhere/core/agent/adapter-api.js";

const EMAIL_THREAD_READ_MAX = 50;

const UNPARSED_PREFIX = "unparsed:";
const UNVERIFIED_PREFIX = "unverified:";

function targetOf(ctx: BindableContext): { inbox: string; threadId: string; dmPrincipal?: string } | undefined {
  const auth = ctx.session?.auth?.current ?? ctx.session?.auth?.initiator;
  const a = auth?.attributes as Readonly<Record<string, unknown>> | undefined;
  const one = (k: string): string | undefined => {
    const v = a?.[k];
    const first = Array.isArray(v) ? v[0] : v;
    return typeof first === "string" && first.length > 0 ? first : undefined;
  };
  const inbox = one("email_inbox");
  const threadId = one("email_thread_id");
  if (!inbox || !threadId) return undefined;
  if (one("email_mode") !== "dm") return { inbox, threadId };
  const principal = typeof auth?.principalId === "string" ? (normalizeEmailAddress(auth.principalId) ?? "") : "";
  return { inbox, threadId, dmPrincipal: principal };
}

function dmOwnMessages(msgs: readonly EmailThreadMessage[], principal: string): readonly EmailThreadMessage[] {
  return msgs.filter((m) => {
    if (m.suspect === true) return false;
    if (m.sent === true) {
      const to = parseMailboxList([...(m.to ?? []), ...(m.cc ?? [])]).map((x) => x.address);
      return to.length > 0 && to.every((a) => a === principal);
    }
    return parseMailbox(m.from)?.address === principal;
  });
}

export const emailReadAdapter: ReadAdapter = {
  platform: "email",
  async readChannel(): Promise<readonly RenderedLine[]> {
    throw new Error("an inbox has no shared channel history to read — use read_thread for the thread of the mail that woke you.");
  },
  async readThread(ctx, channel, threadTs, limit) {
    const own = targetOf(ctx);
    if (!own || own.inbox !== channel || own.threadId !== threadTs) throw new Error("read_thread on email reads only the thread of the mail that woke this turn.");
    const policy = emailPolicy();
    const transport = emailTransport(policy.transport);
    if (!transport?.readThread) throw new Error(`the email transport "${policy.transport}" cannot read a thread.`);
    if (own.dmPrincipal === "") throw new Error("read_thread on a personal inbox needs the person this DM belongs to, and this turn names none.");
    const fetched = await transport.readThread(own.inbox, own.threadId, Math.min(limit ?? EMAIL_THREAD_READ_MAX, EMAIL_THREAD_READ_MAX));
    const msgs = own.dmPrincipal !== undefined ? dmOwnMessages(fetched, own.dmPrincipal) : fetched;
    return msgs.map((m): RenderedLine => {
      const sender = parseMailbox(m.from);
      const self = m.sent === true;
      const unverified = !self && (m.suspect === true || (sender !== undefined && findEmailInbox(policy, sender.address) !== undefined));
      const authorId = !sender
        ? `${UNPARSED_PREFIX}${createHash("sha256").update(m.from).digest("hex").slice(0, 16)}`
        : unverified
          ? `${UNVERIFIED_PREFIX}${sender.address}`
          : sender.address;
      return {
        author: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address) : "unknown sender",
        ts: m.sentAt,
        text: m.text,
        authorId,
        ...(self ? { bot: true } : {}),
      };
    });
  },
  wakeAddress(ctx): WakeReadAddress | undefined {
    const own = targetOf(ctx);
    return own ? { container: own.inbox, threadRoot: own.threadId } : undefined;
  },
  async refutedAuthorIds(_ctx, lines) {
    const policy = emailPolicy();
    const ids = new Set<string>();
    for (const l of lines) {
      if (l.bot) continue;
      if (!l.authorId) {
        ids.add(`${UNPARSED_PREFIX}none`);
        continue;
      }
      if (l.authorId.startsWith(UNPARSED_PREFIX) || l.authorId.startsWith(UNVERIFIED_PREFIX)) {
        ids.add(l.authorId);
        continue;
      }
      const d = emailDomainOf(l.authorId);
      if (!policy.orgDomains.some((od) => d === od || d.endsWith(`.${od}`))) ids.add(l.authorId);
    }
    return [...ids];
  },
};
