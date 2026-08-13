import type { Routine } from "./routine.js";

export interface RoutinePolicyRule {
  readonly id: string;
  readonly rule: string;
  readonly why: string;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly source: "human" | "learned";
  readonly incidentRunAt?: string;
}

export const POLICY_MAX_RULES = 20;

export const POLICY_RULE_MAX_CHARS = 300;
export const POLICY_WHY_MAX_CHARS = 300;

export const UNTRUSTED_DELIMITER_TOKEN = "untrusted_external_data";

export const POLICY_BLOCK_TAG = "[rules]";

export function policyTextProblem(text: string, field: "rule" | "why", maxChars: number): string | null {
  const t = text.trim();
  if (t.length === 0) {
    return field === "why"
      ? "every rule needs a `why` — the incident or reasoning behind it. A rule with no cause can never be safely retired, and it renders into every fire, so say what went wrong."
      : "the rule text is empty — say what the routine must always (or never) do.";
  }
  if (t.length > maxChars) {
    return `the \`${field}\` is ${t.length} characters; the cap is ${maxChars}. It is re-read on every fire of this routine forever, so make it one sentence.`;
  }
  if (/[\n\r]/.test(t)) {
    return `the \`${field}\` must be ONE line — this one has a line break. Two rules are two calls, each with its own card, so each gets its own confirmation and its own provenance.`;
  }
  if (t.includes(UNTRUSTED_DELIMITER_TOKEN)) {
    return `the \`${field}\` contains the untrusted-content envelope delimiter, which a standing rule may never carry — it renders as trusted text and would forge the boundary the fire message uses to separate instructions from data.`;
  }
  if (/^\[[^\]]*\]/.test(t)) {
    return `the \`${field}\` starts with a \`[…]\` tag, which is the fire message's own block grammar (\`${POLICY_BLOCK_TAG}\`, \`[job]\`, \`[watch]\`, \`[silent]\`, \`[health]\`). A rule that opens one would impersonate a host-authored block — rephrase without the brackets.`;
  }
  return null;
}

export function policyAuthorRefusal(
  turn: { readonly inRoutineFire: boolean },
  verb: "add" | "remove",
): string | null {
  if (turn.inRoutineFire) {
    return verb === "add"
      ? "A routine's own run can't add a standing rule — not even to itself. Rules are trusted instructions injected into unattended future runs, so they're only ever armed by a person in the channel. Say what went wrong in your answer instead, and whoever reads it can ask me to add the rule."
      : "A routine's own run can't remove its standing rules. Those rules exist to constrain runs like this one, so a run removing them would be the routine editing its own guardrails. Say why the rule looks wrong in your answer, and someone in the channel can ask me to remove it.";
  }
  return null;
}

export function policyRules(r: Pick<Routine, "policy">): readonly RoutinePolicyRule[] {
  return r.policy ?? [];
}

export interface PolicyAddResult {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly patch: Partial<Routine>;
  readonly count: number;
}

export function applyPolicyAdd(r: Pick<Routine, "policy">, rule: RoutinePolicyRule): PolicyAddResult {
  const existing = policyRules(r);
  const refuse = (reason: string): PolicyAddResult => ({ accepted: false, reason, patch: {}, count: existing.length });

  const ruleProblem = policyTextProblem(rule.rule, "rule", POLICY_RULE_MAX_CHARS);
  if (ruleProblem) return refuse(ruleProblem);
  const whyProblem = policyTextProblem(rule.why, "why", POLICY_WHY_MAX_CHARS);
  if (whyProblem) return refuse(whyProblem);

  if (existing.length >= POLICY_MAX_RULES) {
    return refuse(
      `this routine already has the maximum ${POLICY_MAX_RULES} standing rules. Nothing is dropped automatically — a rule is a guardrail, and silently evicting the oldest to make room for a new one is exactly the removal this tool is gated against. Ask me to list them and remove one first.`,
    );
  }
  const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
  const dupe = existing.find((x) => norm(x.rule) === norm(rule.rule));
  if (dupe) {
    return refuse(`this routine already has that rule (${dupe.id}, added ${dupe.addedAt}) — nothing to add.`);
  }
  const next = [...existing, { ...rule, rule: rule.rule.trim(), why: rule.why.trim() }];
  return { accepted: true, patch: { policy: next }, count: next.length };
}

export interface PolicyRemoveResult {
  readonly removed?: RoutinePolicyRule;
  readonly patch: Partial<Routine>;
  readonly count: number;
}

export function applyPolicyRemove(r: Pick<Routine, "policy">, ruleId: string): PolicyRemoveResult {
  const existing = policyRules(r);
  const removed = existing.find((x) => x.id === ruleId);
  if (!removed) return { patch: {}, count: existing.length };
  const next = existing.filter((x) => x.id !== ruleId);
  return { removed, patch: { policy: next }, count: next.length };
}

function renderRule(x: RoutinePolicyRule): string[] {
  const day = x.addedAt.slice(0, 10);
  const who = x.source === "learned" ? ", proposed by me and confirmed" : "";
  return [`- (${x.id}, ${day}${who}) ${x.rule}`, `    why: ${x.why}`];
}

export function renderPolicyBlock(r: Pick<Routine, "policy">): string {
  const rules = policyRules(r);
  if (rules.length === 0) return "";
  return [
    `${POLICY_BLOCK_TAG} Standing rules for this routine. A human in this channel confirmed each one on an ` +
      `approval card, so they are instructions, not suggestions: they OVERRIDE your default judgement and ` +
      `you follow them exactly. If one conflicts with the task below, the rule wins — say so in your answer ` +
      `rather than working around it.`,
    ...rules.flatMap(renderRule),
    `(${rules.length} of ${POLICY_MAX_RULES} rules. Anyone in this channel can change them — ask me to list, ` +
      `add or remove a rule, and I'll post a card for someone to confirm.)`,
  ].join("\n");
}
