import { routineWords } from "../routines/schedule-words.js";
import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { placeWords } from "../channels/friendly-ids.js";
import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";
import { getRoutine, updateRoutineIf } from "../routines/store.js";
import { attentionResetPatch, isPausedForCheckIn } from "../routines/attention.js";
import { applyPolicyAdd, applyPolicyRemove, POLICY_MAX_RULES, type RoutinePolicyRule } from "../routines/policy.js";
import { armingApproval } from "./arming-context.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

interface RoutinePolicyAddArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly surfaceKey: string;
  readonly routineId: string;
  readonly description: string;
  readonly ruleId: string;
  readonly rule: string;
  readonly why: string;
  readonly source: "human" | "learned";
  readonly incidentRunAt?: string;
  readonly countBefore: number;
  readonly requestedBy: string;
}

const routinePolicyAdd: ActionKind<RoutinePolicyAddArgs> = {
  kind: "routine.policy.add",
  policy: "member",
  plainSummary(args) {
    return `Add a standing rule to ${routineWords(args.description)}`;
  },
  consequence: (args) => `${plainQuote(args.rule, QUOTE_MAX - 50)} — every future run follows it, unattended ones too`,
  consequenceQuotes: true,
  summarize(args) {
    return [
      `Add a standing rule to routine ${args.routineId} — ${args.description}`,
      `Rule: ${args.rule}`,
      `Why: ${args.why}`,
      "✍️ the agent wrote the text above — read it as written, not as what you asked for",
      ...(args.source === "learned"
        ? ["⚠ the agent proposed this ITSELF after a run, rather than being asked for it by anyone"]
        : []),
      ...(args.incidentRunAt ? [`Prompted by the run at ${args.incidentRunAt}`] : []),
      `It becomes TRUSTED text in every future fire of this routine, including unattended ones, until someone removes it (${args.countBefore} → ${args.countBefore + 1} of ${POLICY_MAX_RULES} rules)`,
      `Target: ${placeWords({ key: args.surfaceKey })}`,
    ];
  },
  async execute(args, decidedBy) {
    const routine = await getRoutine(args.org, args.surfaceKey, args.routineId);
    if (!routine) {
      return `${routineWords(args.description)} was stopped before this, so nothing changed`;
    }
    const rule: RoutinePolicyRule = {
      id: args.ruleId,
      rule: args.rule,
      why: args.why,
      addedAt: new Date().toISOString(),
      addedBy: decidedBy,
      source: args.source,
      ...(args.incidentRunAt ? { incidentRunAt: args.incidentRunAt } : {}),
    };
    const result = applyPolicyAdd(routine, rule);
    if (!result.accepted) {
      return `rule not added: ${result.reason}`;
    }
    const written = await updateRoutineIf(args.org, args.surfaceKey, args.routineId, () => true, (live) => ({ ...result.patch, ...(isPausedForCheckIn(live) ? {} : attentionResetPatch()) }));
    if (written.kind !== "written") {
      return `${routineWords(args.description)} was stopped before this, so nothing changed`;
    }
    const arming = armingApproval();
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.policy.add",
      detail: {
        routineId: args.routineId,
        ruleId: rule.id,
        rule: rule.rule,
        why: rule.why,
        source: rule.source,
        armedBy: decidedBy,
        requestedBy: args.requestedBy,
        ...(rule.incidentRunAt ? { incidentRunAt: rule.incidentRunAt } : {}),
        ...(arming ? { approvalId: arming.id } : {}),
        rules: result.count,
      },
    });
    return `rule added. ${routineWords(args.description)} follows it from its next run (${result.count} of ${POLICY_MAX_RULES} rules)`;
  },
};

interface RoutinePolicyRemoveArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly surfaceKey: string;
  readonly routineId: string;
  readonly description: string;
  readonly ruleId: string;
  readonly ruleText: string;
  readonly why: string;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly countBefore: number;
  readonly requestedBy: string;
}

const routinePolicyRemove: ActionKind<RoutinePolicyRemoveArgs> = {
  kind: "routine.policy.remove",
  policy: "member",
  plainSummary(args) {
    return `Remove a standing rule from ${routineWords(args.description)}`;
  },
  consequence: (args) => `${plainQuote(args.ruleText, QUOTE_MAX - 60)} — someone added it after an incident`,
  consequenceQuotes: true,
  summarize(args) {
    return [
      `Remove a standing rule from routine ${args.routineId} — ${args.description}`,
      `Rule (${args.ruleId}): ${args.ruleText}`,
      `Added ${args.addedAt} by ${args.addedBy} because: ${args.why}`,
      "🛡️ this is a guardrail someone armed after an incident — future fires stop following it, with no further notice",
      `${args.countBefore} → ${args.countBefore - 1} of ${POLICY_MAX_RULES} rules`,
      `Target: ${placeWords({ key: args.surfaceKey })}`,
    ];
  },
  async execute(args, decidedBy) {
    const routine = await getRoutine(args.org, args.surfaceKey, args.routineId);
    if (!routine) {
      return `${routineWords(args.description)} was stopped before this, so nothing changed`;
    }
    const result = applyPolicyRemove(routine, args.ruleId);
    if (!result.removed) {
      return "that rule was already removed, so nothing changed";
    }
    const written = await updateRoutineIf(args.org, args.surfaceKey, args.routineId, () => true, (live) => ({ ...result.patch, ...(isPausedForCheckIn(live) ? {} : attentionResetPatch()) }));
    if (written.kind !== "written") {
      return `${routineWords(args.description)} was stopped before this, so nothing changed`;
    }
    const arming = armingApproval();
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.policy.remove",
      detail: {
        routineId: args.routineId,
        ruleId: result.removed.id,
        rule: result.removed.rule,
        why: result.removed.why,
        source: result.removed.source,
        originallyAddedBy: result.removed.addedBy,
        originallyAddedAt: result.removed.addedAt,
        armedBy: decidedBy,
        requestedBy: args.requestedBy,
        ...(arming ? { approvalId: arming.id } : {}),
        rules: result.count,
      },
    });
    const left = result.count === 0 ? "it now has no standing rules" : `${result.count} of ${POLICY_MAX_RULES} left`;
    return `rule removed. ${routineWords(args.description)} no longer follows it (${left})`;
  },
};

registerActionKind(routinePolicyAdd);
registerActionKind(routinePolicyRemove);
