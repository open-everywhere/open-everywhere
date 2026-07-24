import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { routineMarker } from "../routines/routine.js";
import { completeJob } from "../routines/lifecycle.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { auditToolAction } from "../audit/tool-action.js";
import type { BindableContext } from "../identity/binding.js";

export default defineTool({
  description:
    "Mark this DURABLE JOB done — call it once the WHOLE job you were set to drive is finished (not " +
    "just this fire's step). The job then retires and never fires again; its record is kept for audit. " +
    "Only valid inside a job routine's own run; use cancel_routine to stop an ordinary routine.",
  inputSchema: z.object({
    reason: z.string().min(1).describe("One line on the final outcome — what got done (audit + list visibility)."),
  }),
  outputSchema: z.object({
    completed: z.boolean(),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const auth = ctx.session?.auth;
    const marker = routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes);
    if (!marker) {
      throw new Error("complete_job only works inside a job routine's own run — this session has no routine attached.");
    }
    const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
    if (!routine) throw new Error(`Routine ${marker.id} no longer exists (cancelled while this job ran).`);

    const result = completeJob(routine, input.reason, new Date());
    if (result.kind === "not-a-job") {
      throw new Error(
        `Routine ${marker.id} is an ordinary routine, not a durable job — there is no job to complete. ` +
          `Use cancel_routine to stop a scheduled routine, or record_watch_state for a watch.`,
      );
    }
    if (result.kind === "already-done") {
      return { completed: true, note: `Job ${marker.id} was already marked done — nothing to do.` };
    }
    const r = result.routine;
    await updateRoutine(marker.org, marker.surfaceKey, marker.id, {
      status: r.status,
      completedAt: r.completedAt,
      completedReason: r.completedReason,
      disabledReason: r.disabledReason,
      nextRunAt: r.nextRunAt,
    });
    await auditToolAction(ctx as BindableContext, "routine.complete", {
      id: marker.id,
      surfaceKey: marker.surfaceKey,
      reason: r.completedReason,
    });
    return { completed: true, note: `Job ${marker.id} marked done — it will not fire again.` };
  },
});
