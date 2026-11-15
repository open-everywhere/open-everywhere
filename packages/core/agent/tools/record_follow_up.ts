import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { routineMarker } from "../routines/routine.js";
import {
  applyFollowUp,
  followUpNameValid,
  resolveFollowUp,
  FOLLOW_UP_NOTE_MAX_CHARS,
  MAX_ROUTINE_FOLLOW_UPS,
} from "../routines/follow-ups.js";
import { getRoutine, updateRoutine } from "../routines/store.js";

export default defineTool({
  description:
    "Leave a named follow-up for the NEXT run of this same routine, or resolve one you have finished. " +
    "This routine's next fire starts on a fresh session with none of this conversation, so a follow-up here " +
    "is the only thing that reaches it. Use it for work you could not finish, a thing worth re-checking, or " +
    "a conclusion the next run should not have to re-derive. Call it again with the same name to update that " +
    `note, or with resolved: true to remove it. At most ${MAX_ROUTINE_FOLLOW_UPS} follow-ups are kept; past ` +
    "that the oldest is dropped. Only valid inside a routine's own run.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .describe("Short stable name for this follow-up — the address a later run reads it back by, and resolves it by."),
    note: z
      .string()
      .max(FOLLOW_UP_NOTE_MAX_CHARS)
      .optional()
      .describe("What the next run needs to know. One or two sentences — a pointer, not a report. Required unless resolved is true."),
    resolved: z.boolean().optional().describe("true = this follow-up is finished: remove it so it stops arriving on later runs."),
  }),
  outputSchema: z.object({
    followUps: z.array(z.string()).describe("The names this routine now carries, in the order later runs will read them."),
    evicted: z.string().optional().describe(`Set when this write dropped the oldest follow-up to stay under ${MAX_ROUTINE_FOLLOW_UPS}.`),
  }),
  approval: never(),
  async execute(input, ctx) {
    const auth = ctx.session?.auth;
    const marker = routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes);
    if (!marker) {
      throw new Error("record_follow_up only works inside a routine's own run — this session has no routine attached.");
    }
    if (!followUpNameValid(input.name)) {
      throw new Error(
        `"${input.name}" is not a usable follow-up name: use letters, digits, spaces, ".", "-" or "_", up to 64 characters. ` +
          "The name is an address a later run has to spell back, so it cannot carry newlines or punctuation that will not survive a round trip.",
      );
    }
    const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
    if (!routine) throw new Error(`Routine ${marker.id} no longer exists (cancelled while this run was working).`);

    if (input.resolved === true) {
      const done = resolveFollowUp(routine, input.name);
      await updateRoutine(marker.org, marker.surfaceKey, marker.id, done.patch);
      return { followUps: done.followUps.map((f) => f.name) };
    }
    if (input.note === undefined || input.note.trim().length === 0) {
      throw new Error("A follow-up needs a note saying what the next run should know — or resolved: true to remove one.");
    }
    const write = applyFollowUp(routine, {
      name: input.name,
      note: input.note,
      at: new Date().toISOString(),
    });
    await updateRoutine(marker.org, marker.surfaceKey, marker.id, write.patch);
    return { followUps: write.followUps.map((f) => f.name), ...(write.evicted ? { evicted: write.evicted } : {}) };
  },
});
