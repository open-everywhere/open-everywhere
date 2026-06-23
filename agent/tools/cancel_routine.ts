import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { removeRoutine } from "../routines/store.js";

export default defineTool({
  description:
    "Cancel (delete) a routine on this surface by its id. Get the id from list_routines. Use when asked to stop a scheduled job, watch, or subscription.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
  }),
  outputSchema: z.object({
    cancelled: z.boolean(),
    id: z.string(),
  }),
  needsApproval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const cancelled = await removeRoutine(p, input.id);
    if (!cancelled) {
      throw new Error(`No routine '${input.id}' on this surface — check the id with list_routines.`);
    }
    return { cancelled, id: input.id };
  },
});
