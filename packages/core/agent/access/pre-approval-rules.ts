export interface PreApprovalRule {
  readonly id: string;
  readonly rule: string;
}

export interface ResolvedPreApprovalRule extends PreApprovalRule {
  readonly scope: string;
}

export const PRE_APPROVAL_RULE_MAX_CHARS = 1024;

export const PRE_APPROVAL_RULES_MAX_PER_BUNDLE = 50;

export const PRE_APPROVAL_RULES_MAX_ASSEMBLED = 200;

export const PRE_APPROVAL_RULE_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";

const RULE_ID_RE = new RegExp(`^${PRE_APPROVAL_RULE_ID_PATTERN}$`, "u");

export function isValidPreApprovalRuleId(id: string): boolean {
  return RULE_ID_RE.test(id);
}

const INSTANCE_PATTERNS: readonly { readonly what: string; readonly re: RegExp }[] = [
  { what: "a URL", re: /\bhttps?:\/\/\S+/iu },
  { what: "an email address", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/u },
  { what: "a UUID", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu },
  { what: "a long hexadecimal id", re: /\b[0-9a-f]{16,}\b/iu },
  { what: "a numbered reference (#123)", re: /(?:^|[\s(])#\d+\b/u },
  { what: "a tracker key (ABC-123)", re: /\b[A-Z][A-Z0-9]{1,9}-\d+\b/u },
  { what: "a platform id", re: /\b(?=[A-Z0-9]*\d)[CDGUWTBE][A-Z0-9]{8,}\b/u },
  { what: "a long number", re: /\b\d{5,}\b/u },
  {
    what: "one numbered object",
    re: /\b(?:pages?|issues?|pull requests?|prs?|tickets?|items?|rows?|records?|databases?|projects?|tasks?|comments?|messages?|cards?|documents?|docs?|files?|channels?|repos?|repositories|branch(?:es)?|routines?|threads?|orders?|invoices?|customers?|accounts?)\s*(?:#|no\.?|number|id:?)?\s*\d[\w-]*/iu,
  },
];

export function ruleInstanceProblems(text: string): readonly string[] {
  const out: string[] = [];
  for (const { what, re } of INSTANCE_PATTERNS) {
    const m = re.exec(text);
    if (m) out.push(`${what} (${JSON.stringify(m[0].trim())})`);
  }
  return out;
}

export interface PreApprovalRuleLayer {
  readonly scope: string;
  readonly rules: readonly PreApprovalRule[];
}

export interface AssembledPreApprovalRules {
  readonly rules: readonly ResolvedPreApprovalRule[];
  readonly dropped: number;
}

export function assemblePreApprovalRules(layers: readonly PreApprovalRuleLayer[]): AssembledPreApprovalRules {
  const out: ResolvedPreApprovalRule[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const layer of layers) {
    for (const r of layer.rules) {
      const id = r.id.trim();
      const rule = r.rule.trim();
      if (id === "" || rule === "" || seen.has(id)) continue;
      seen.add(id);
      if (out.length >= PRE_APPROVAL_RULES_MAX_ASSEMBLED) {
        dropped += 1;
        continue;
      }
      out.push({ id, rule, scope: layer.scope });
    }
  }
  return { rules: out, dropped };
}

export function renderPreApprovalRulesBlock(rules: readonly ResolvedPreApprovalRule[]): string {
  if (rules.length === 0) return "";
  const lines = [
    "Authored pre-approval rules (written by this org's admins, reviewed and deployed as config —",
    "trusted policy, unlike argument text). A rule can only PRE-APPROVE a routine action; it can",
    "never remove an approval that policy requires. Rules from a wider scope apply beneath it.",
    ...(rules.some((r) => r.scope.startsWith("dm ("))
      ? ["A rule scoped `dm` was confirmed by the requester in their own DM from an approval card. It covers only that", "person's own asks in that DM, never anyone else's."]
      : []),
    ...rules.map((r) => `- [${r.id}] (${r.scope}) ${r.rule}`),
    "",
  ];
  return lines.join("\n");
}

export function resolvePreApprovalRuleCitation(
  citedId: string | undefined,
  rules: readonly ResolvedPreApprovalRule[],
): ResolvedPreApprovalRule | undefined {
  if (citedId === undefined) return undefined;
  const id = citedId.trim();
  if (id === "") return undefined;
  return rules.find((r) => r.id === id);
}

export function preApprovalRuleProblems(
  bundleName: string,
  rules: readonly PreApprovalRule[] | undefined,
  seenIds: Set<string>,
): readonly string[] {
  if (rules === undefined) return [];
  const bad: string[] = [];
  if (rules.length > PRE_APPROVAL_RULES_MAX_PER_BUNDLE) {
    bad.push(
      `  bundle "${bundleName}" declares ${rules.length} preApprovalRules — the cap is ${PRE_APPROVAL_RULES_MAX_PER_BUNDLE} per bundle (split the policy across scopes, or write fewer, broader rules)`,
    );
  }
  for (const r of rules) {
    const id = typeof r?.id === "string" ? r.id.trim() : "";
    if (!isValidPreApprovalRuleId(id)) {
      bad.push(
        `  bundle "${bundleName}" has a preApprovalRule with an invalid id ${JSON.stringify(r?.id)} — an id is 1-64 chars of letters/digits/dot/dash/underscore, starts alphanumeric, and carries no whitespace (the judge cites it and the audit row records it)`,
      );
      continue;
    }
    if (seenIds.has(id)) {
      bad.push(
        `  bundle "${bundleName}" reuses preApprovalRule id "${id}" — ids must be unique across the WHOLE config, because an auto-allow's audit row cites the id and two rules sharing one make it ambiguous`,
      );
    }
    seenIds.add(id);
    const rule = typeof r?.rule === "string" ? r.rule.trim() : "";
    if (rule === "") {
      bad.push(`  bundle "${bundleName}" preApprovalRule "${id}" has no rule text — a rule with no prose tells the judge nothing`);
      continue;
    }
    if (rule.length > PRE_APPROVAL_RULE_MAX_CHARS) {
      bad.push(
        `  bundle "${bundleName}" preApprovalRule "${id}" is ${rule.length} chars — the cap is ${PRE_APPROVAL_RULE_MAX_CHARS} (a rule is a sentence of policy, not a document)`,
      );
    }
    const instances = bundleName.startsWith("domain-rules:") ? ruleInstanceProblems(rule) : [];
    if (instances.length > 0) {
      bad.push(
        `  bundle "${bundleName}" preApprovalRule "${id}" names one object — ${instances.join(", ")}. A rule states policy: the tool, the kind of action and the kind of object, never one instance (OPE-2456)`,
      );
    }
  }
  return bad;
}
