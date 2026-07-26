import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger, routineGrantGeneration } from "../routines/routine.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE rewriting what an existing routine DOES, keeping its schedule, its id, its history and everything it has learned (a watch's baseline, a durable job's progress and thread). Get the id from list_routines. Use when someone wants to change, correct or refine a routine's instruction — always prefer this over cancelling and re-creating, which loses all of that. This does NOT edit on the spot: a card posts showing the old and new text side by side, and it changes only when a human confirms. Note for the user: confirming also revokes any standing approvals the routine had built up, so it goes back to asking. To change the SCHEDULE or the post policy instead, cancel it and create a new one. Needs a surface with an approval-card path (Slack/Discord). The posted card IS the reply — do not add narration after this call.",
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
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "edit_routine");
    const p = resolvePartition(ctx);
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
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(
        `edit_routine needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must read the new instruction before it can fire unattended.`,
      );
    }
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("edit_routine needs a verified sender to gate the change — no principal id resolved, so there's no requester to show on the approval card.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("edit_routine couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

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
          tainted,
          generation: routineGrantGeneration(routine),
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
      id,
      trigger: description,
      message: `card posted — rewrite of routine ${id} (${description})${tainted ? " ⚠ tainted" : ""} awaiting a human to confirm (pending ${posted.id}). Its schedule, history and run state are kept; its standing approvals are revoked on confirm.`,
    };
  },
});
