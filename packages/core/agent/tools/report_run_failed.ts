import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { routineMarker } from "../routines/routine.js";
import { declareRunFailed, MAX_CONSECUTIVE_FAILURES } from "../routines/lifecycle.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { noteDeclaredRunFailure, type FireBagContext } from "../hooks/routine-outcome.js";

export default defineTool({
  description:
    "Declare that THIS routine fire did not do its work — the thing you needed was down, a credential " +
    "was rejected, the page never loaded. Call it before you finish; reporting the problem only in " +
    "your answer leaves the run recorded as a success. Do NOT call it when the work succeeded and the " +
    `news was merely bad. ${MAX_CONSECUTIVE_FAILURES} declared failures in a row disable the routine. ` +
    "Only valid inside a routine's own fired run.",
  inputSchema: z.object({
    reason: z.string().min(1).describe("One line on what went wrong — it lands in the audit trail next to this routine's id."),
  }),
  outputSchema: z.object({
    recorded: z
      .boolean()
      .describe(
        "true = this run is now recorded as failed; finish your turn normally. false = this run was already settled, " +
          "so the declaration does not count — read the note.",
      ),
    consecutiveFailures: z
      .number()
      .describe("Failures in a row INCLUDING this one once the run settles — at the threshold the routine disables itself."),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const auth = ctx.session?.auth;
    const marker = routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes);
    if (!marker) {
      throw new Error("report_run_failed only works inside a routine's own fired run — this session has no routine attached.");
    }
    const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
    if (!routine) throw new Error(`Routine ${marker.id} no longer exists (cancelled while this run was in flight).`);

    const declared = declareRunFailed(input.reason);
    await updateRoutine(marker.org, marker.surfaceKey, marker.id, declared.patch);

    const fate = noteDeclaredRunFailure(ctx as unknown as FireBagContext);

    const willBe = routine.consecutiveFailures + 1;
    if (fate === "uncounted") {
      return {
        recorded: false,
        consecutiveFailures: routine.consecutiveFailures,
        note:
          "This run is already settled, so the declaration is NOT counted toward the three-strike total " +
          `(still ${routine.consecutiveFailures} in a row). The reason is on the routine's row for the audit trail. ` +
          "Say what went wrong in your answer.",
      };
    }
    return {
      recorded: true,
      consecutiveFailures: willBe,
      note:
        willBe >= MAX_CONSECUTIVE_FAILURES
          ? `Recorded. That is ${willBe} in a row — this routine will disable itself when this run ends, and the room will be told.`
          : `Recorded as a failed run (${willBe} of ${MAX_CONSECUTIVE_FAILURES} in a row).`,
    };
  },
});
