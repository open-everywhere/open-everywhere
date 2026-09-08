import { defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { markThreadStopped, roomEngagementAddress } from "../channels/engagement.js";
import { appendAudit } from "../audit/audit.js";

export const STAND_DOWN_ACTION = "engagement.stood_down";

export const DM_REFUSAL =
  "stand_down: a direct message cannot be stood down, so nothing was marked — reply that you could NOT stop following here, because a DM has no @mention to bring you back.";

export const GROUP_REFUSAL =
  "stand_down: this surface answers every message in a group conversation without checking whether you asked it to stop, so nothing was marked — reply that you could NOT stop following here, and that this is a limit of how the agent is built on this surface rather than something anyone in the conversation can change.";

export default defineTool({
  description:
    "Stop following this conversation — call it when the people here have asked you to stop, to go " +
    "quiet, or to leave them to it, however they phrased it. You stay in the channel and lose " +
    "nothing; you simply stop being woken by messages here until somebody @mentions you again. " +
    "Reach for it on a clear ask to stop, not on a lull — silence is already your normal output, " +
    "and `no_reply` is the right ending for a message that merely wasn't for you. After calling " +
    "this, send a one-line acknowledgement with the `reply` tool — trailing prose is discarded — " +
    "then end the turn.",
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
    if (binding.mode === "dm") throw new Error(DM_REFUSAL);
    if (binding.mode === "mpim" && !binding.engagementKey) throw new Error(GROUP_REFUSAL);
    const anchor = binding.engagementKey ?? binding.threadTs;
    if (!anchor) {
      throw new Error(
        "stand_down: this turn carries no conversation anchor, so nothing was marked — reply that you could NOT stop following here, and that someone must ask again in the conversation or ask an admin.",
      );
    }
    const partition = resolvePartition(c);
    let marked = await markThreadStopped(partition, anchor);
    const room = binding.roomEngagementKey === undefined ? null : roomEngagementAddress(partition);
    let stoppedRoom = false;
    if (!marked && room) {
      marked = await markThreadStopped(room.partition, room.anchor);
      stoppedRoom = marked;
    }
    await appendAudit({
      org: partition.org,
      platform: partition.platform,
      workspace: partition.workspace,
      surface: partition.surfaceKey,
      action: STAND_DOWN_ACTION,
      detail: {
        surfaceKey: partition.surfaceKey,
        anchor,
        marked,
        reason: input.reason ?? null,
        ...(binding.roomEngagementKey === undefined ? {} : { roomAnchor: binding.roomEngagementKey, roomStop: stoppedRoom }),
      },
    }).catch(() => undefined);
    if (!marked) {
      throw new Error(
        "stand_down: nothing was marked, so this stop did not take — reply that you could NOT stop following here, because either this conversation was never enrolled, which an @mention fixes, or the registry could not be written to just now.",
      );
    }
    return {
      standingDown: true,
      note: stoppedRoom
        ? "Standing down here — you won't be woken by messages anywhere in this room until someone " +
          "@mentions you again. Acknowledge it in one short line and end the turn."
        : "Standing down here — you won't be woken by messages in this conversation until someone " +
          "@mentions you again. Acknowledge it in one short line and end the turn.",
    };
  },
});
