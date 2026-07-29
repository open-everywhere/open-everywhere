import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger, routineMarker } from "../routines/routine.js";
import { policyAuthorRefusal, policyRules } from "../routines/policy.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE removing ONE standing rule from a routine — the rule stops being applied to every future run. Use when a rule is stale, wrong, or is being replaced (to change a rule, remove it and add the new one: two confirmations, so each wording is read on its own). Get the routine id and its rule ids from list_routines. This does NOT remove it on the spot: a card posts naming the rule, who armed it and why they did, and it goes only when a human confirms. Needs a surface with an approval-card path (Slack/Discord). The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    routineId: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
    ruleId: z.string().min(1).describe("The rule id, e.g. 'p-1a2b3c4d' (from list_routines's `rules`, or the rule block in a run's message)."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    routineId: z.string(),
    ruleId: z.string(),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "remove_routine_rule");

    const auth = ctx.session?.auth;
    const refusal = policyAuthorRefusal(
      {
        inRoutineFire: routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes) !== null,
        tainted: untrustedIngestedThisTurn(),
      },
      "remove",
    );
    if (refusal) throw new Error(refusal);

    const p = resolvePartition(ctx);
    const routineId = input.routineId.trim();
    const ruleId = input.ruleId.trim();

    const routine = await getRoutine(p.org, p.surfaceKey, routineId);
    if (!routine) {
      throw new Error(`No routine '${routineId}' on this surface — check the id with list_routines.`);
    }
    const rules = policyRules(routine);
    const target = rules.find((x) => x.id === ruleId);
    if (!target) {
      const known = rules.length > 0 ? ` It has: ${rules.map((x) => x.id).join(", ")}.` : " It has no standing rules.";
      throw new Error(`Routine '${routineId}' has no rule '${ruleId}'.${known}`);
    }

    const description = describeTrigger(routine.trigger, routine.report);
    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(
        `remove_routine_rule needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must confirm taking a guardrail away.`,
      );
    }
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "remove_routine_rule needs a verified sender to gate the removal — no principal id resolved, so there's no requester to show on the approval card.",
      );
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("remove_routine_rule couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.policy.remove",
        args: {
          org: p.org,
          partition: p,
          surfaceKey: p.surfaceKey,
          routineId,
          description,
          ruleId: target.id,
          ruleText: target.rule,
          why: target.why,
          addedAt: target.addedAt,
          addedBy: target.addedBy,
          countBefore: rules.length,
          requestedBy,
        },
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    return {
      pending: true,
      pendingId: posted.id,
      routineId,
      ruleId: target.id,
      message: `card posted — removal of standing rule ${target.id} from routine ${routineId} (${description}) awaiting a human to confirm (pending ${posted.id}). Until someone clicks, the rule still applies.`,
    };
  },
});
