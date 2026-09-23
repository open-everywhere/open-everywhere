import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger, routineMarker } from "../routines/routine.js";
import { policyAuthorRefusal, policyRules } from "../routines/policy.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE removing ONE standing rule from a routine — the rule stops being applied to every future run. Use when a rule is stale, wrong, or is being replaced (to change a rule, remove it and add the new one: two confirmations, so each wording is read on its own). Get the routine id and its rule ids from list_routines. This does NOT remove it on the spot: a card posts naming the rule, who armed it and why they did, and it goes only when a human confirms. The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `message` field names it, and you MUST relay that.",
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
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "remove_routine_rule");

    const auth = ctx.session?.auth;
    const refusal = policyAuthorRefusal(
      { inRoutineFire: routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes) !== null },
      "remove",
    );
    if (refusal) throw new Error(refusal);

    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
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
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "remove_routine_rule needs a verified sender to gate the removal — no principal id resolved, so there's no requester to show on the approval card.",
      );
    }

    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "remove that rule"));
    }
    const venue = venueResult.venue;

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
        scopeKey: proposeScopeKey,
        domain: null,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const subject = `removal of standing rule ${target.id} from routine ${routineId} (${description})`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        routineId,
        ruleId: target.id,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      routineId,
      ruleId: target.id,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}). Until someone clicks, the rule still applies.${cardPostedTail(venue, "confirm the removal", posted)}`,
    };
  },
});
