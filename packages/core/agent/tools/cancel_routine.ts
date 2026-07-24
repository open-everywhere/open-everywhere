import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger } from "../routines/routine.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE cancelling (deleting) a routine on this surface by its id. Get the id from list_routines. Use when asked to stop a scheduled job, watch, or subscription. This does NOT cancel on the spot: an approval card posts naming the exact routine, and it's removed only when a human confirms (cancelling removes a guardrail, so it's gated). Needs a surface with an approval-card path (Slack/Discord). The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    id: z.string(),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "cancel_routine");
    const p = resolvePartition(ctx);
    const id = input.id.trim();

    const routine = await getRoutine(p.org, p.surfaceKey, id);
    if (!routine) {
      throw new Error(`No routine '${id}' on this surface — check the id with list_routines.`);
    }
    const description = describeTrigger(routine.trigger);

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(`cancel_routine needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must confirm the cancellation.`);
    }
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("cancel_routine needs a verified sender to gate the removal — no principal id resolved, so there's no requester to show on the approval card.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("cancel_routine couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.cancel",
        args: { org: p.org, partition: p, surfaceKey: p.surfaceKey, id, description, requestedBy },
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
      message: `card posted — cancel of routine ${id} (${description}) awaiting a human to confirm (pending ${posted.id}).`,
    };
  },
});
