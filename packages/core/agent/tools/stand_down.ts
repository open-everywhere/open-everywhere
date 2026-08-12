import { defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { markThreadStopped } from "../channels/engagement.js";
import { appendAudit } from "../audit/audit.js";

export const STAND_DOWN_ACTION = "engagement.stood_down";

export default defineTool({
  description:
    "Stop following this conversation — call it when the people here have asked you to stop, to go " +
    "quiet, or to leave them to it, however they phrased it. You stay in the channel and lose " +
    "nothing; you simply stop being woken by messages here until somebody @mentions you again. " +
    "Reach for it on a clear ask to stop, not on a lull — silence is already your normal output, " +
    "and `no_reply` is the right ending for a message that merely wasn't for you. After calling " +
    "this, acknowledge it in ONE short line and end the turn.",
  inputSchema: z.object({
    reason: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("One short phrase for the trail — how the ask was made (e.g. \"asked me to stop following\"). Never message text."),
  }),
  outputSchema: z.object({ standingDown: z.boolean(), note: z.string() }),
  async execute(input, ctx) {
    const c = ctx as BindableContext;
    const binding = bindFrom(c);
    const threadTs = binding.threadTs;
    if (!threadTs) {
      throw new Error(
        "stand_down: couldn't tell which conversation to stop following — this turn carries no thread anchor. " +
          "If you were asked to stop, say so in a reply instead.",
      );
    }
    const partition = resolvePartition(c);
    const marked = await markThreadStopped(partition, threadTs);
    await appendAudit({
      org: partition.org,
      platform: partition.platform,
      workspace: partition.workspace,
      surface: partition.surfaceKey,
      action: STAND_DOWN_ACTION,
      detail: { surfaceKey: partition.surfaceKey, threadTs, marked, reason: input.reason ?? null },
    }).catch(() => undefined);
    return {
      standingDown: true,
      note:
        "Standing down here — you won't be woken by messages in this conversation until someone " +
        "@mentions you again. Acknowledge it in one short line and end the turn.",
    };
  },
});
