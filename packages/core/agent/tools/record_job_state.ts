import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { routineMarker, JOB_STATE_MAX_BYTES } from "../routines/routine.js";
import { applyJobStateObservation } from "../routines/job.js";
import { getRoutine, updateRoutine } from "../routines/store.js";

export default defineTool({
  description:
    "Record your progress on this DURABLE JOB — a short, canonical note (goal, what's done, what's " +
    `next) that survives even if this session is later replaced, so it's your reliable hand-off to ` +
    `the next fire. Call it near the end of each fire. Max ${JOB_STATE_MAX_BYTES} bytes. Only valid ` +
    "inside a job routine's own run.",
  inputSchema: z.object({
    state: z.string().min(1).describe("Canonical progress note: the goal, what's done so far, and what's left."),
  }),
  outputSchema: z.object({
    recorded: z.boolean(),
    bytes: z.number().describe("UTF-8 byte size of the note that was stored (or would have been, if rejected)."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const auth = ctx.session?.auth;
    const marker = routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes);
    if (!marker) {
      throw new Error("record_job_state only works inside a job routine's own run — this session has no routine attached.");
    }
    const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
    if (!routine) throw new Error(`Routine ${marker.id} no longer exists (cancelled while this job ran).`);
    if (routine.sessionMode !== "job") {
      throw new Error(`Routine ${marker.id} is not a durable job — there is no job ledger to write. (A watch uses record_watch_state.)`);
    }

    const obs = applyJobStateObservation(input.state);
    if (!obs.accepted) {
      throw new Error(`That note is ${obs.bytes} bytes — the job ledger cap is ${JOB_STATE_MAX_BYTES}. Trim it to a compact progress summary (it's a ledger, not a document store).`);
    }
    await updateRoutine(marker.org, marker.surfaceKey, marker.id, obs.patch);
    return { recorded: true, bytes: obs.bytes };
  },
});
