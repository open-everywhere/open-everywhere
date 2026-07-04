import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { routineMarker } from "../routines/routine.js";
import { applyWatchObservation, WATCH_SILENCE_SENTINEL } from "../routines/watch.js";
import { getRoutine, updateRoutine } from "../routines/store.js";

export default defineTool({
  description:
    "Record the state a WATCH routine just observed, and learn whether it changed since the last check. " +
    "Call this exactly once per watch check, with a canonical text representation of the watched state " +
    "(stable ordering; leave out values that differ on every look, like timestamps). If it returns " +
    `changed: false, end your turn with exactly ${WATCH_SILENCE_SENTINEL} and nothing else. ` +
    "Only valid inside a watch routine's own run.",
  inputSchema: z.object({
    state: z.string().min(1).describe("Canonical text representation of the watched state as observed right now."),
  }),
  outputSchema: z.object({
    changed: z
      .boolean()
      .describe(`false = unchanged since the last check: end the turn with exactly ${WATCH_SILENCE_SENTINEL}, posting nothing.`),
    firstObservation: z.boolean().describe("true = no baseline existed yet — report what you observed as the baseline."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const auth = ctx.session?.auth;
    const marker = routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes);
    if (!marker) {
      throw new Error("record_watch_state only works inside a watch routine's own run — this session has no routine attached.");
    }
    const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
    if (!routine) throw new Error(`Routine ${marker.id} no longer exists (cancelled while this check ran).`);
    if (routine.trigger.kind !== "watch") {
      throw new Error(`Routine ${marker.id} is a ${routine.trigger.kind} routine, not a watch — there is no state to diff.`);
    }

    const obs = applyWatchObservation(routine, input.state);
    await updateRoutine(marker.org, marker.surfaceKey, marker.id, obs.patch);
    return { changed: obs.changed, firstObservation: obs.firstObservation };
  },
});
