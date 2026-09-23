import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger, routinePermissionGeneration } from "../routines/routine.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE rewriting what an existing routine DOES, keeping its schedule, its id, its history and everything it has learned (a watch's baseline, a durable job's progress and thread). Get the id from list_routines. Use when someone wants to change, correct or refine a routine's instruction — always prefer this over cancelling and re-creating, which loses all of that. This does NOT edit on the spot: a card posts showing the old and new text side by side, and it changes only when a human confirms. Note for the user: confirming also revokes any standing approvals the routine had built up, so it goes back to asking. To change the SCHEDULE or the post policy instead, cancel it and create a new one. The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `message` field names it, and you MUST relay that.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
    prompt: z
      .string()
      .min(1)
      .describe(
        "The NEW instruction, written as a complete self-contained replacement — not a diff, not an " +
          "addition. It replaces the old text wholesale, and an ordinary fire has no prior thread context.",
      ),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    id: z.string(),
    trigger: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "edit_routine");
    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const id = input.id.trim();
    const prompt = input.prompt.trim();

    const routine = await getRoutine(p.org, p.surfaceKey, id);
    if (!routine) {
      throw new Error(`No routine '${id}' on this surface — check the id with list_routines.`);
    }
    if (routine.status === "done") {
      throw new Error(
        `Routine '${id}' is a finished job (${routine.completedReason ?? "completed"}) — a completed job is terminal and won't fire again, so editing it would change nothing. Create a fresh routine if the work has come back.`,
      );
    }
    if (prompt === routine.prompt.trim()) {
      throw new Error(
        `That's the text routine '${id}' already has — nothing to change. (Editing would still revoke its standing approvals, so it isn't a free no-op.)`,
      );
    }
    const description = describeTrigger(routine.trigger, routine.report);

    const binding = bindFrom(ctx);
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("edit_routine needs a verified sender to gate the change — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose rewriting the instruction it or another routine runs under. Ask a person in this conversation to change it.");
    }

    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "rewrite that routine"));
    }
    const venue = venueResult.venue;

    const tainted = untrustedIngestedThisTurn();
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.edit",
        args: {
          org: p.org,
          partition: p,
          surfaceKey: p.surfaceKey,
          id,
          prompt,
          previousPrompt: routine.prompt,
          description,
          requestedBy,
          trigger: routine.trigger,
          ...(routine.report ? { report: routine.report } : {}),
          ...(routine.sessionMode ? { sessionMode: routine.sessionMode } : {}),
          tainted,
          generation: routinePermissionGeneration(routine),
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

    const subject = `rewrite of routine ${id} (${description})${tainted ? " ⚠ tainted" : ""}`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        id,
        trigger: description,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      id,
      trigger: description,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}). Its schedule, history and run state are kept; its standing approvals are revoked on confirm.${cardPostedTail(venue, "confirm the rewrite", posted)}`,
    };
  },
});
