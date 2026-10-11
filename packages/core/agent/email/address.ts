const ADDRESS_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

export interface ParsedMailbox {
  readonly address: string;
  readonly name?: string;
}

export function normalizeEmailAddress(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const a = raw.trim().toLowerCase();
  if (a.length > 254 || !ADDRESS_RE.test(a)) return undefined;
  const local = a.slice(0, a.lastIndexOf("@"));
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
  return a;
}

export function parseMailbox(raw: string): ParsedMailbox | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  const angles = s.match(/<([^<>]*)>/g);
  if (angles && angles.length > 1) return undefined;
  if (angles && angles.length === 1) {
    const address = normalizeEmailAddress(angles[0]!.slice(1, -1));
    if (!address) return undefined;
    const name = s
      .slice(0, s.indexOf("<"))
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    return name.length > 0 ? { address, name: name.slice(0, 120) } : { address };
  }
  const address = normalizeEmailAddress(s);
  return address ? { address } : undefined;
}

export function parseMailboxList(raw: readonly string[] | undefined): readonly ParsedMailbox[] {
  const out: ParsedMailbox[] = [];
  const seen = new Set<string>();
  for (const r of raw ?? []) {
    const m = parseMailbox(r);
    if (!m || seen.has(m.address)) continue;
    seen.add(m.address);
    out.push(m);
  }
  return out;
}

export function emailDomainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

export function emailLocalPartOf(address: string): string {
  return address.slice(0, address.lastIndexOf("@"));
}

export function domainIsWithin(domain: string, parent: string): boolean {
  const d = domain.toLowerCase();
  const p = parent.toLowerCase();
  return d === p || d.endsWith(`.${p}`);
}

export function normalizeSenderRule(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const r = raw.trim().toLowerCase();
  if (r.startsWith("*@")) {
    const probe = normalizeEmailAddress(`x${r.slice(1)}`);
    return probe ? `*@${emailDomainOf(probe)}` : undefined;
  }
  return normalizeEmailAddress(r);
}

export function senderRuleMatches(rule: string, address: string): boolean {
  if (rule.startsWith("*@")) return emailDomainOf(address) === rule.slice(2);
  return rule === address;
}
