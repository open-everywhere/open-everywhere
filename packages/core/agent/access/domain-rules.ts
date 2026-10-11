import type { Binding, Bundle } from "./bundle.js";
import { isValidPreApprovalRuleId, ruleInstanceProblems, PRE_APPROVAL_RULE_MAX_CHARS, type PreApprovalRule } from "./pre-approval-rules.js";

export interface DomainRuleEntry extends PreApprovalRule {
  readonly domain: string;
  readonly subject?: { readonly tool: string; readonly action: string; readonly objects: readonly string[]; readonly ops?: readonly string[] };
}

function domainRuleBundleName(domain: string): string {
  return `domain-rules:${domain}`;
}

export function defineDomainRules(entries: readonly DomainRuleEntry[]): readonly DomainRuleEntry[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const label = `domain rule ${JSON.stringify(e?.id)}`;
    if (typeof e?.domain !== "string" || e.domain.trim() === "") bad.push(`  ${label} names no domain`);
    if (typeof e?.id !== "string" || !isValidPreApprovalRuleId(e.id)) {
      bad.push(`  ${label} has an invalid id — 1-64 chars of letters/digits/dot/dash/underscore, starting alphanumeric`);
      continue;
    }
    if (seen.has(e.id)) bad.push(`  ${label} appears twice — an id is the judge's citation, so it must be unique`);
    seen.add(e.id);
    const rule = typeof e.rule === "string" ? e.rule.trim() : "";
    if (rule === "") bad.push(`  ${label} has no rule text`);
    if (rule.length > PRE_APPROVAL_RULE_MAX_CHARS) bad.push(`  ${label} is ${rule.length} chars — the cap is ${PRE_APPROVAL_RULE_MAX_CHARS}`);
    const instances = ruleInstanceProblems(rule);
    if (instances.length > 0) bad.push(`  ${label} names one object — ${instances.join(", ")}. A rule states policy, never one instance`);
  }
  if (bad.length > 0) throw new Error(`agent/access/domain-rules.ts is invalid:\n${bad.join("\n")}`);
  return entries;
}

export function domainRuleBundles(entries: readonly DomainRuleEntry[]): Bundle[] {
  const byDomain = new Map<string, PreApprovalRule[]>();
  for (const e of entries) {
    const list = byDomain.get(e.domain) ?? [];
    list.push({ id: e.id, rule: e.rule });
    byDomain.set(e.domain, list);
  }
  return [...byDomain.entries()].map(([domain, rules]): Bundle => ({ name: domainRuleBundleName(domain), preApprovalRules: rules }));
}

export function domainRuleBindings(entries: readonly DomainRuleEntry[]): Binding[] {
  return [...new Set(entries.map((e) => e.domain))].map((domain): Binding => ({ bundle: domainRuleBundleName(domain), scope: { level: "domain", domain } }));
}

const OPEN_CALL = "defineDomainRules([";
const CLOSE_LINE = /^\]\);[ \t]*$/u;

function renderDomainRuleLine(entry: DomainRuleEntry): string {
  return `  ${JSON.stringify(entry)},`;
}

export interface DomainRuleUpsertResult {
  readonly text: string;
  readonly change: "added" | "widened" | "unchanged";
  readonly previous?: DomainRuleEntry;
}

function readDomainRuleLines(fileText: string): { readonly lines: string[]; readonly open: number; readonly close: number; readonly entries: ReadonlyMap<number, DomainRuleEntry> } {
  const lines = fileText.split("\n");
  const opens = lines.flatMap((l, i) => (l.includes(OPEN_CALL) ? [i] : []));
  if (opens.length !== 1) {
    throw new Error(`agent/access/domain-rules.ts does not hold exactly one \`${OPEN_CALL}\` call, so the rule has no certain place. Add it by hand in a pull request.`);
  }
  const open = opens[0]!;
  const close = lines.findIndex((l, i) => i > open && CLOSE_LINE.test(l));
  if (close === -1) throw new Error(`agent/access/domain-rules.ts has no \`]);\` line after \`${OPEN_CALL}\`. Add the rule by hand in a pull request.`);
  const entries = new Map<number, DomainRuleEntry>();
  for (let i = open + 1; i < close; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith("//")) continue;
    if (!t.endsWith(",")) throw new Error(`agent/access/domain-rules.ts line ${i + 1} is not one JSON entry with a trailing comma. Add the rule by hand in a pull request.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(t.slice(0, -1));
    } catch {
      throw new Error(`agent/access/domain-rules.ts line ${i + 1} is not one JSON entry. Add the rule by hand in a pull request.`);
    }
    entries.set(i, parsed as DomainRuleEntry);
  }
  return { lines, open, close, entries };
}

export function upsertDomainRuleEntry(fileText: string, entry: DomainRuleEntry): DomainRuleUpsertResult {
  const { lines, close, entries } = readDomainRuleLines(fileText);
  const line = renderDomainRuleLine(entry);
  for (const [i, existing] of entries) {
    if (existing.domain !== entry.domain || existing.id !== entry.id) continue;
    if (lines[i] === line) return { text: fileText, change: "unchanged" };
    const next = [...lines];
    next[i] = line;
    return { text: next.join("\n"), change: "widened", previous: existing };
  }
  const next = [...lines.slice(0, close), line, ...lines.slice(close)];
  return { text: next.join("\n"), change: "added" };
}

export function findDomainRuleEntry(fileText: string, domain: string, id: string): DomainRuleEntry | undefined {
  for (const e of readDomainRuleLines(fileText).entries.values()) if (e.domain === domain && e.id === id) return e;
  return undefined;
}
