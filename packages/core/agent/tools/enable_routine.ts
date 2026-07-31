import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger } from "../routines/routine.js";
import { computeNextRun } from "../routines/schedule.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE re-arming a routine that stopped itself after repeated failures, keeping its id, its history and everything it had learned (a watch's baseline, a durable job's progress and thread). Get the id from list_routines with includeDisabled. Use when someone says to start a stopped routine again, or after fixing whatever it was failing on — always prefer this over creating a new one, which loses all of that. This does NOT re-arm on the spot: a card posts naming why it stopped, and it starts again only when a human confirms. Fix the underlying problem first, or it will just fail three more times and stop again.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines with includeDisabled: true)."),
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
    await requireSessionContinuation(ctx, "enable_routine");
    const p = resolvePartition(ctx);
    const id = input.id.trim();

    const routine = await getRoutine(p.org, p.surfaceKey, id);
    if (!routine) {
      throw new Error(`No routine '${id}' on this surface — check the id with list_routines (includeDisabled: true shows stopped ones).`);
    }
    if (routine.status === "active") {
      throw new Error(`Routine '${id}' is already active (${describeTrigger(routine.trigger, routine.report)})${routine.nextRunAt ? `, next run ${routine.nextRunAt}` : ""} — nothing to re-arm.`);
    }
    if (routine.status === "done") {
      throw new Error(
        `Routine '${id}' is a finished job — it declared itself done (${routine.completedReason ?? "completed"}), which is terminal, not a failure. Create a fresh job if the work has come back.`,
      );
    }
    if (routine.trigger.kind === "once") {
      throw new Error(
        `Routine '${id}' was a one-shot (${describeTrigger(routine.trigger, routine.report)}) and its moment has passed — there's nothing left to re-arm. Create a new one-shot for when you want the next check.`,
      );
    }
    if (computeNextRun(routine.trigger, new Date()) === null) {
      throw new Error(`Routine '${id}'s schedule (${describeTrigger(routine.trigger, routine.report)}) never fires again — re-arming it would leave it active but idle. Create a new routine with a workable schedule.`);
    }

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(
        `enable_routine needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must confirm before it fires unattended again.`,
      );
    }
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("enable_routine needs a verified sender to gate the re-arm — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose restarting a routine the three-strike guard stopped. Ask a person in this conversation to re-arm it.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("enable_routine couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const description = describeTrigger(routine.trigger, routine.report);
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.enable",
        args: {
          org: p.org,
          partition: p,
          surfaceKey: p.surfaceKey,
          id,
          description,
          disabledReason: routine.disabledReason ?? "no reason recorded",
          consecutiveFailures: routine.consecutiveFailures,
          prompt: routine.prompt,
          trigger: routine.trigger,
          requestedBy,
          ...(routine.bound ? { bounded: true } : {}),
          ...(routine.stalledFires ? { stalled: true } : {}),
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
      message: `card posted — re-arm of routine ${id} (${description}) awaiting a human to confirm (pending ${posted.id}). Its id, history and run state are kept.`,
    };
  },
});
