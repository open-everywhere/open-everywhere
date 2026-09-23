import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { getRoutine, newPolicyRuleId } from "../routines/store.js";
import { describeTrigger, routineMarker } from "../routines/routine.js";
import {
  POLICY_MAX_RULES,
  POLICY_RULE_MAX_CHARS,
  POLICY_WHY_MAX_CHARS,
  policyAuthorRefusal,
  policyRules,
  policyTextProblem,
} from "../routines/policy.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE a standing rule for ONE routine — a short instruction every future run of that routine must follow, e.g. 'never post before 09:00 UTC' or 'ignore pull requests opened by bots'. Use when someone corrects a routine after a bad run ('don't do that again', 'it should have skipped that one'), or wants to tune how one behaves, WITHOUT rewriting its whole instruction. Get the id from list_routines. Every rule needs a `why` — the incident or reasoning behind it — because the rule is re-read on every run for as long as it exists and nobody can retire it safely without knowing what it was for. This does NOT arm on the spot: a card posts showing the rule and its reason, and it takes effect only when a human confirms. If the thing to record is a FACT ABOUT THE ORG rather than an instruction for this one routine, save it to the channel's memory instead — that is a file edit in the silo the memory index names, not a tool call; to replace the routine's whole instruction, use `edit_routine`. The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `message` field names it, and you MUST relay that.",
  inputSchema: z.object({
    routineId: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
    rule: z
      .string()
      .min(1)
      .max(POLICY_RULE_MAX_CHARS)
      .describe(
        `The rule, as ONE line of plain imperative English the routine must follow (max ${POLICY_RULE_MAX_CHARS} chars). ` +
          "Write it as a standing instruction ('never …', 'always …', 'skip … when …'), not as a description of what went wrong.",
      ),
    why: z
      .string()
      .min(1)
      .max(POLICY_WHY_MAX_CHARS)
      .describe(
        `REQUIRED: why this rule exists — the incident or the reasoning (max ${POLICY_WHY_MAX_CHARS} chars), one line. ` +
          "Name the concrete thing that happened where you can ('the 2026-07-19 run woke the channel at 03:12'), not a restatement of the rule.",
      ),
    source: z
      .enum(["human", "learned"])
      .default("human")
      .describe(
        "'human' when a person in this conversation asked for this rule; 'learned' when YOU are proposing it yourself after noticing a problem nobody raised. Say 'learned' honestly — it is shown on the card so the person confirming knows nobody asked for it.",
      ),
    incidentRunAt: z
      .string()
      .optional()
      .describe("Optional ISO timestamp of the run that prompted this rule (a routine's lastRunAt, from list_routines)."),
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
    await requireSessionContinuation(ctx, "add_routine_rule");

    const auth = ctx.session?.auth;
    const refusal = policyAuthorRefusal(
      { inRoutineFire: routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes) !== null },
      "add",
    );
    if (refusal) throw new Error(refusal);

    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const routineId = input.routineId.trim();
    const rule = input.rule.trim();
    const why = input.why.trim();

    for (const [text, field, cap] of [
      [rule, "rule", POLICY_RULE_MAX_CHARS],
      [why, "why", POLICY_WHY_MAX_CHARS],
    ] as const) {
      const problem = policyTextProblem(text, field, cap);
      if (problem) throw new Error(`That rule can't be armed as written — ${problem}`);
    }

    const routine = await getRoutine(p.org, p.surfaceKey, routineId);
    if (!routine) {
      throw new Error(`No routine '${routineId}' on this surface — check the id with list_routines.`);
    }
    if (routine.status === "done") {
      throw new Error(
        `Routine '${routineId}' is a finished job (${routine.completedReason ?? "completed"}) — it will never fire again, so a rule for it would never be read. Create a fresh routine if the work has come back.`,
      );
    }
    const existing = policyRules(routine);
    if (existing.length >= POLICY_MAX_RULES) {
      throw new Error(
        `Routine '${routineId}' already has the maximum ${POLICY_MAX_RULES} standing rules, and I never drop one automatically to make room — that would silently remove a guardrail. Ask me to list them and remove one first.`,
      );
    }
    const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
    const dupe = existing.find((x) => norm(x.rule) === norm(rule));
    if (dupe) {
      throw new Error(`Routine '${routineId}' already has that rule (${dupe.id}, added ${dupe.addedAt}) — nothing to add.`);
    }

    const description = describeTrigger(routine.trigger, routine.report);
    const binding = bindFrom(ctx);
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "add_routine_rule needs a verified sender to gate the rule — no principal id resolved, so there's no requester to show on the approval card.",
      );
    }

    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "add that rule"));
    }
    const venue = venueResult.venue;

    const ruleId = newPolicyRuleId();
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.policy.add",
        args: {
          org: p.org,
          partition: p,
          surfaceKey: p.surfaceKey,
          routineId,
          description,
          ruleId,
          rule,
          why,
          source: input.source,
          ...(input.incidentRunAt ? { incidentRunAt: input.incidentRunAt } : {}),
          countBefore: existing.length,
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

    const subject = `standing rule ${ruleId} for routine ${routineId} (${description})`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        routineId,
        ruleId,
        message: `${autoApprovedNote(subject, posted.autoApproved)} It applies from the next fire on.`,
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      routineId,
      ruleId,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}). It takes effect on the next fire after someone clicks, and shows up in every fire after that.${cardPostedTail(venue, "confirm the rule", posted)}`,
    };
  },
});
