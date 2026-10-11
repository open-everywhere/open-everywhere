import { processRegistrySlot } from "../lib/process-registry.js";
import { domainIsWithin, emailDomainOf, emailLocalPartOf, normalizeEmailAddress, normalizeSenderRule } from "./address.js";

export interface EmailInbox {
  readonly address: string;
  readonly kind: "room" | "personal";
  readonly allowedSenders: readonly string[];
  readonly why: string;
}

export interface EmailPolicy {
  readonly enabled: boolean;
  readonly transport: string;
  readonly orgDomains: readonly string[];
  readonly inboxes: readonly EmailInbox[];
  readonly maxRecipients: number;
  readonly maxInboundChars: number;
}

export interface EmailSenderEntry {
  readonly inbox: string;
  readonly sender: string;
  readonly why: string;
  readonly requestedBy?: string;
  readonly approvedBy?: string;
}

export const DEFAULT_EMAIL_POLICY: EmailPolicy = Object.freeze({
  enabled: false,
  transport: "",
  orgDomains: Object.freeze([]) as readonly string[],
  inboxes: Object.freeze([]) as readonly EmailInbox[],
  maxRecipients: 10,
  maxInboundChars: 20_000,
});

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function emailInboxSurfaceKey(address: string): string {
  return `email/${emailDomainOf(address)}/${emailSurfaceSegment(emailLocalPartOf(address))}`;
}

export function emailSurfaceSegment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

export function emailPolicyProblems(p: EmailPolicy, senders: readonly EmailSenderEntry[] = []): readonly string[] {
  const problems: string[] = [];
  if (typeof p.enabled !== "boolean") problems.push("enabled must be true or false");
  if (p.enabled && (typeof p.transport !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.transport))) {
    problems.push("transport must name a registered email transport (lowercase id) when enabled");
  }
  const int = (v: unknown, lo: number, hi: number, name: string): void => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) problems.push(`${name} must be an integer from ${lo} to ${hi}`);
  };
  int(p.maxRecipients, 1, 20, "maxRecipients");
  int(p.maxInboundChars, 1_000, 100_000, "maxInboundChars");
  if (!Array.isArray(p.orgDomains)) {
    problems.push("orgDomains must be a list");
    return problems;
  }
  for (const d of p.orgDomains) {
    if (typeof d !== "string" || !DOMAIN_RE.test(d)) problems.push(`orgDomains: "${String(d)}" is not a lowercase mail domain`);
  }
  if (!Array.isArray(p.inboxes)) {
    problems.push("inboxes must be a list");
    return problems;
  }
  if (p.enabled && p.inboxes.length === 0) problems.push("enabled with no inboxes would refuse every mail — declare an inbox, or set enabled: false");
  const seen = new Set<string>();
  const surfaceKeys = new Set<string>();
  const roomInboxes = new Set<string>();
  for (const box of p.inboxes) {
    const address = normalizeEmailAddress(String(box?.address ?? ""));
    const at = `inbox "${String(box?.address)}"`;
    if (!address) {
      problems.push(`${at}: not an email address`);
      continue;
    }
    if (address !== box.address) problems.push(`${at}: write the address in lowercase as "${address}"`);
    if (seen.has(address)) problems.push(`${at}: declared twice`);
    seen.add(address);
    const key = emailInboxSurfaceKey(address);
    if (surfaceKeys.has(key)) problems.push(`${at}: its surface key ${key} collides with another inbox`);
    surfaceKeys.add(key);
    if (!p.orgDomains.some((d) => typeof d === "string" && domainIsWithin(emailDomainOf(address), d))) {
      problems.push(`${at}: its domain is not one of orgDomains — an inbox must live on a domain the org controls`);
    }
    if (box.kind !== "room" && box.kind !== "personal") problems.push(`${at}: kind must be "room" or "personal"`);
    if (typeof box.why !== "string" || box.why.trim().length === 0) problems.push(`${at}: say why this deployment owns this inbox`);
    if (!Array.isArray(box.allowedSenders)) {
      problems.push(`${at}: allowedSenders must be a list`);
      continue;
    }
    if (box.kind === "personal" && box.allowedSenders.length > 0) {
      problems.push(`${at}: a personal inbox lists no allowedSenders — only a person declared in agent/identity/principals.ts (ids.email) can reach a DM seat`);
    }
    for (const rule of box.allowedSenders) {
      if (!normalizeSenderRule(String(rule))) problems.push(`${at}: sender rule "${String(rule)}" is not an address or "*@domain"`);
    }
    if (box.kind === "room") roomInboxes.add(address);
  }
  if (!Array.isArray(senders)) {
    problems.push("the sender additions must be a list");
    return problems;
  }
  for (const s of senders) {
    const at = `sender addition "${String(s?.sender)}" for "${String(s?.inbox)}"`;
    const inbox = normalizeEmailAddress(String(s?.inbox ?? ""));
    if (!inbox || !roomInboxes.has(inbox)) problems.push(`${at}: names no room inbox declared in agent/email/policy.ts`);
    if (!normalizeSenderRule(String(s?.sender ?? ""))) problems.push(`${at}: not an address or "*@domain"`);
    if (typeof s?.why !== "string" || s.why.trim().length === 0) problems.push(`${at}: say why this sender may write`);
  }
  return problems;
}

export function defineEmailPolicy(p: EmailPolicy, senders: readonly EmailSenderEntry[] = []): EmailPolicy {
  const problems = emailPolicyProblems(p, senders);
  if (problems.length > 0) {
    throw new Error(`email policy is unusable — the email surface stays OFF (fail closed):\n${problems.map((x) => `  - ${x}`).join("\n")}`);
  }
  const extra = new Map<string, string[]>();
  for (const s of senders) {
    const inbox = normalizeEmailAddress(s.inbox)!;
    extra.set(inbox, [...(extra.get(inbox) ?? []), normalizeSenderRule(s.sender)!]);
  }
  return Object.freeze({
    ...p,
    orgDomains: Object.freeze([...p.orgDomains]),
    inboxes: Object.freeze(
      p.inboxes.map((b) =>
        Object.freeze({
          ...b,
          allowedSenders: Object.freeze([...new Set([...b.allowedSenders.map((r) => normalizeSenderRule(r)!), ...(extra.get(b.address) ?? [])])]),
        }),
      ),
    ),
  });
}

export function defineEmailSenders(entries: readonly EmailSenderEntry[]): readonly EmailSenderEntry[] {
  const bad: string[] = [];
  for (const e of entries) {
    if (!normalizeEmailAddress(String(e?.inbox ?? ""))) bad.push(`  "${String(e?.inbox)}" is not an inbox address`);
    if (!normalizeSenderRule(String(e?.sender ?? ""))) bad.push(`  "${String(e?.sender)}" is not an address or "*@domain"`);
    if (typeof e?.why !== "string" || e.why.trim().length === 0) bad.push(`  the entry for "${String(e?.sender)}" says no why`);
  }
  if (bad.length > 0) throw new Error(`agent/email/senders.ts is invalid:\n${bad.join("\n")}`);
  return entries;
}

const SLOT = processRegistrySlot<EmailPolicy>("email-policy.v1");

export function registerEmailPolicy(p: EmailPolicy, senders: readonly EmailSenderEntry[] = []): void {
  SLOT.set(defineEmailPolicy(p, senders));
}

export function emailPolicy(): EmailPolicy {
  return SLOT.get() ?? DEFAULT_EMAIL_POLICY;
}

export function resetEmailPolicyForTest(): void {
  SLOT.set(null);
}

export function findEmailInbox(policy: EmailPolicy, address: string): EmailInbox | undefined {
  const a = normalizeEmailAddress(address);
  return a ? policy.inboxes.find((b) => b.address === a) : undefined;
}

export function isOwnInbox(policy: EmailPolicy, address: string): boolean {
  return findEmailInbox(policy, address) !== undefined;
}
