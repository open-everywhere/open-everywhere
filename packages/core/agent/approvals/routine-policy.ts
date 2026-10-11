import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { applyPolicyAdd, applyPolicyRemove, POLICY_MAX_RULES, type RoutinePolicyRule } from "../routines/policy.js";
import { armingApproval } from "./arming-context.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

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
    return `Add a standing rule to the routine "${plainValue(args.description)}"`;
  },
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
      `Target: ${args.surfaceKey}`,
    ];
  },
  async execute(args, decidedBy) {
    const routine = await getRoutine(args.org, args.surfaceKey, args.routineId);
    if (!routine) {
      return `routine ${args.routineId} is gone — it was cancelled before this rule was confirmed, so nothing changed.`;
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
      return `rule not added to routine ${args.routineId} — ${result.reason}`;
    }
    const updated = await updateRoutine(args.org, args.surfaceKey, args.routineId, result.patch);
    if (!updated) {
      return `routine ${args.routineId} is gone — it was cancelled before this rule was confirmed, so nothing changed.`;
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
    return (
      `rule ${rule.id} added to routine ${args.routineId} (${result.count} of ${POLICY_MAX_RULES}). ` +
      `Every fire from now on is told: “${rule.rule}”. Remove it with \`remove_routine_rule\` — that asks for a confirmation too.`
    );
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
    return `Remove a standing rule from the routine "${plainValue(args.description)}"`;
  },
  summarize(args) {
    return [
      `Remove a standing rule from routine ${args.routineId} — ${args.description}`,
      `Rule (${args.ruleId}): ${args.ruleText}`,
      `Added ${args.addedAt} by ${args.addedBy} because: ${args.why}`,
      "🛡️ this is a guardrail someone armed after an incident — future fires stop following it, with no further notice",
      `${args.countBefore} → ${args.countBefore - 1} of ${POLICY_MAX_RULES} rules`,
      `Target: ${args.surfaceKey}`,
    ];
  },
  async execute(args, decidedBy) {
    const routine = await getRoutine(args.org, args.surfaceKey, args.routineId);
    if (!routine) {
      return `routine ${args.routineId} is gone — it was cancelled before this removal was confirmed, so nothing changed.`;
    }
    const result = applyPolicyRemove(routine, args.ruleId);
    if (!result.removed) {
      return `rule ${args.ruleId} is no longer on routine ${args.routineId} — it was already removed, so nothing changed.`;
    }
    const updated = await updateRoutine(args.org, args.surfaceKey, args.routineId, result.patch);
    if (!updated) {
      return `routine ${args.routineId} is gone — it was cancelled before this removal was confirmed, so nothing changed.`;
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
    return `rule ${result.removed.id} removed from routine ${args.routineId} — ${left}. Future fires are no longer told “${result.removed.rule}”.`;
  },
};

registerActionKind(routinePolicyAdd);
registerActionKind(routinePolicyRemove);
