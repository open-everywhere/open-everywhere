import { surfaceAccounts, type Principal } from "../identity/principals.js";
import { domainIsWithin, emailDomainOf, normalizeEmailAddress, parseMailbox, parseMailboxList, senderRuleMatches, type ParsedMailbox } from "./address.js";
import { findEmailInbox, isOwnInbox, type EmailInbox, type EmailPolicy } from "./policy.js";
import type { InboundEmail } from "./transport.js";

export type EmailRefusalReason =
  | "disabled"
  | "no-inbox"
  | "shared-domain"
  | "self"
  | "automated"
  | "flagged"
  | "unauthenticated"
  | "not-allowed"
  | "unknown-person"
  | "unparseable-sender";

export interface EmailPrincipalMatch {
  readonly name: string;
}

export type EmailAdmission =
  | {
      readonly admit: true;
      readonly inbox: EmailInbox;
      readonly sender: ParsedMailbox;
      readonly trust: "internal" | "external";
      readonly principal?: EmailPrincipalMatch;
      readonly via: "allowed-sender" | "principal";
    }
  | { readonly admit: false; readonly reason: EmailRefusalReason; readonly sender?: string };

export function isAutomatedEmail(mail: Pick<InboundEmail, "headers" | "from">): boolean {
  const h = (k: string): string => (mail.headers[k] ?? "").trim().toLowerCase();
  const autoSubmitted = h("auto-submitted");
  if (autoSubmitted !== "" && autoSubmitted !== "no") return true;
  if (["bulk", "list", "junk", "auto_reply"].includes(h("precedence"))) return true;
  if (h("list-id") !== "" || h("list-unsubscribe") !== "") return true;
  if (h("x-autoreply") !== "" || h("x-autorespond") !== "") return true;
  if (/\b(all|oof|autoreply)\b/.test(h("x-auto-response-suppress"))) return true;
  const from = parseMailbox(mail.from)?.address ?? "";
  const local = from.slice(0, from.lastIndexOf("@"));
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)(\+.*)?$/.test(local);
}

export function principalForEmail(principals: readonly Principal[], address: string): EmailPrincipalMatch | undefined {
  for (const p of principals) {
    for (const acct of surfaceAccounts(p.ids)) {
      if (acct.platform !== "email") continue;
      if (normalizeEmailAddress(acct.id) === address) return { name: p.name };
    }
  }
  return undefined;
}

export function isOrgAddress(policy: EmailPolicy, address: string): boolean {
  const d = emailDomainOf(address);
  return policy.orgDomains.some((od) => domainIsWithin(d, od));
}

export function admitInboundEmail(input: {
  readonly policy: EmailPolicy;
  readonly mail: InboundEmail;
  readonly principals: readonly Principal[];
  readonly sharedDomains: readonly string[];
}): EmailAdmission {
  const { policy, mail } = input;
  if (!policy.enabled) return { admit: false, reason: "disabled" };
  const inbox = findEmailInbox(policy, mail.inbox);
  if (!inbox) return { admit: false, reason: "no-inbox" };
  if (input.sharedDomains.some((d) => domainIsWithin(emailDomainOf(inbox.address), d))) return { admit: false, reason: "shared-domain" };
  const sender = parseMailbox(mail.from);
  if (!sender) return { admit: false, reason: "unparseable-sender" };
  if (isOwnInbox(policy, sender.address)) return { admit: false, reason: "self", sender: sender.address };
  if (isAutomatedEmail(mail)) return { admit: false, reason: "automated", sender: sender.address };
  if (mail.flagged) return { admit: false, reason: "flagged", sender: sender.address };
  if (mail.senderAuth !== "pass") return { admit: false, reason: "unauthenticated", sender: sender.address };
  const trust = isOrgAddress(policy, sender.address) ? "internal" : "external";
  const principal = principalForEmail(input.principals, sender.address);
  if (inbox.kind === "personal") {
    if (!principal) return { admit: false, reason: "unknown-person", sender: sender.address };
    return { admit: true, inbox, sender, trust, principal, via: "principal" };
  }
  if (!inbox.allowedSenders.some((rule) => senderRuleMatches(rule, sender.address))) {
    return { admit: false, reason: "not-allowed", sender: sender.address };
  }
  return { admit: true, inbox, sender, trust, ...(principal ? { principal } : {}), via: "allowed-sender" };
}

export function mayReceiveReply(policy: EmailPolicy, inbox: EmailInbox, principals: readonly Principal[], address: string): boolean {
  if (isOwnInbox(policy, address)) return false;
  if (isOrgAddress(policy, address)) return true;
  if (inbox.allowedSenders.some((rule) => senderRuleMatches(rule, address))) return true;
  return principalForEmail(principals, address) !== undefined;
}

export interface ReplyRecipientPlan {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly dropped: number;
  readonly outsider: boolean;
}

export function planReplyRecipients(input: {
  readonly policy: EmailPolicy;
  readonly inbox: EmailInbox;
  readonly principals: readonly Principal[];
  readonly sender: string;
  readonly mail: Pick<InboundEmail, "replyTo" | "to" | "cc">;
}): ReplyRecipientPlan {
  const { policy, inbox, principals } = input;
  const others = parseMailboxList([...input.mail.to, ...input.mail.cc]).map((m) => m.address);
  const outsider = (all: readonly string[]): boolean => all.some((a) => !isOrgAddress(policy, a));
  if (inbox.kind === "personal") {
    const dropped = new Set(others.filter((a) => a !== input.sender && !isOwnInbox(policy, a))).size;
    return { to: [input.sender], cc: [], dropped, outsider: outsider([input.sender]) };
  }
  const ok = (a: string): boolean => mayReceiveReply(policy, inbox, principals, a);
  const replyTo = parseMailboxList(input.mail.replyTo).find((m) => ok(m.address))?.address;
  const primary = replyTo ?? input.sender;
  const candidates = [...new Set([input.sender, ...others])].filter((a) => a !== primary);
  let dropped = 0;
  const cc: string[] = [];
  for (const a of candidates) {
    if (isOwnInbox(policy, a)) continue;
    if (!ok(a) || 1 + cc.length >= policy.maxRecipients) {
      dropped++;
      continue;
    }
    cc.push(a);
  }
  return { to: [primary], cc, dropped, outsider: outsider([primary, ...cc]) };
}
