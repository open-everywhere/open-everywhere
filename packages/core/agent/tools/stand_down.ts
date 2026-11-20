import { defineTool } from "eve/tools";
import { z } from "zod";
import { auditSurfaceModeStamp, bindFrom, currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { holdStandDownAck, markThreadStopped, readStandDownAck, roomEngagementAddress } from "../channels/engagement.js";
import { durableTurnKey } from "../model/turn-state.js";
import { markStoodDownThisTurn, peekDeliveryArm } from "../channels/reply-signal.js";
import { standDownAckSentence, type DeliveryArm } from "../instructions/seat-prompt.js";
import { appendAudit } from "../audit/audit.js";

export const STAND_DOWN_ACTION = "engagement.stood_down";

export const STAND_DOWN_REFUSALS = {
  dm: "dm",
  group: "group-wake-ignores-registry",
  anchorless: "no-conversation-anchor",
} as const;

export const DM_REFUSAL =
  "stand_down: a direct message cannot be stood down, so nothing was marked — reply that you could NOT stop following here, because a DM has no @mention to bring you back.";

export const GROUP_REFUSAL =
  "stand_down: this surface answers every message in a group conversation without checking whether you asked it to stop, so nothing was marked — reply that you could NOT stop following here, and that this is a limit of how the agent is built on this surface rather than something anyone in the conversation can change.";

const DELIVERY_ARM_KINDS: Readonly<Record<DeliveryArm["kind"], true>> = {
  "wake-addressed": true,
  "reply-only": true,
  "closing-text": true,
  "dual-mode": true,
};

export function standDownAckRoute(): string {
  const stamped = peekDeliveryArm();
  const kind = stamped !== null && Object.hasOwn(DELIVERY_ARM_KINDS, stamped) ? (stamped as DeliveryArm["kind"]) : "dual-mode";
  return standDownAckSentence(kind);
}

export default defineTool({
  description:
    "Stop following this conversation — call it when the people here have asked you to stop, to go " +
    "quiet, or to leave them to it, however they phrased it. You stay in the channel and lose " +
    "nothing; you simply stop being woken by messages here until somebody @mentions you again. " +
    "Reach for it on a clear ask to stop, not on a lull — silence is already your normal output, " +
    "and `no_reply` is the right ending for a message that merely wasn't for you. After calling " +
    "this, acknowledge it in one short line and end the turn — this tool's own result names the " +
    "route that acknowledgement leaves by on this seat, and `no_reply` is not it.",
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
    const partition = resolvePartition(c);
    const auditRefusal = async (refused: string): Promise<void> => {
      const carried = binding.engagementKey ?? binding.threadTs;
      await appendAudit({
        org: partition.org,
        platform: partition.platform,
        workspace: partition.workspace,
        surface: partition.surfaceKey,
        ...auditSurfaceModeStamp(binding),
        action: STAND_DOWN_ACTION,
        detail: {
          surfaceKey: partition.surfaceKey,
          anchor: carried && carried.length > 0 ? carried : null,
          refused,
          reason: input.reason ?? null,
        },
      }).catch(() => undefined);
    };
    if (binding.mode === "dm") {
      await auditRefusal(STAND_DOWN_REFUSALS.dm);
      throw new Error(DM_REFUSAL);
    }
    if (binding.mode === "mpim" && !binding.engagementKey) {
      await auditRefusal(STAND_DOWN_REFUSALS.group);
      throw new Error(GROUP_REFUSAL);
    }
    const anchor = binding.engagementKey ?? binding.threadTs;
    if (!anchor) {
      await auditRefusal(STAND_DOWN_REFUSALS.anchorless);
      throw new Error(
        "stand_down: this turn carries no conversation anchor, so nothing was marked — reply that you could NOT stop following here, and that someone must ask again in the conversation or ask an admin.",
      );
    }
    const room = binding.roomEngagementKey === undefined ? null : roomEngagementAddress(partition);
    let marked = await markThreadStopped(partition, anchor);
    let stoppedRoom = false;
    if (!marked && room) {
      marked = await markThreadStopped(room.partition, room.anchor);
      stoppedRoom = marked;
    }
    let acknowledgedElsewhere = false;
    if (marked) {
      const ackPartition = stoppedRoom && room ? room.partition : partition;
      const ackAnchor = stoppedRoom && room ? room.anchor : anchor;
      const holder = standDownHolderKey(c, currentTurnId(c));
      const claim = await holdStandDownAck(ackPartition, ackAnchor, holder);
      if (claim === "taken") {
        const prior = await readStandDownAck(ackPartition, ackAnchor);
        const mine = prior.kind === "held" && holder !== undefined && prior.holder === holder && !prior.spent;
        acknowledgedElsewhere = prior.kind !== "unreadable" && !mine;
      }
    }
    await appendAudit({
      org: partition.org,
      platform: partition.platform,
      workspace: partition.workspace,
      surface: partition.surfaceKey,
      ...auditSurfaceModeStamp(binding),
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
    if (acknowledgedElsewhere) {
      return { standingDown: true, note: ALREADY_ACKNOWLEDGED_NOTE };
    }
    markStoodDownThisTurn(currentTurnId(c));
    return {
      standingDown: true,
      note:
        (stoppedRoom
          ? "Standing down here — you won't be woken by messages anywhere in this room until someone @mentions you again. "
          : "Standing down here — you won't be woken by messages in this conversation until someone @mentions you again. ") +
        `This turn still owes a one-line acknowledgement. ${standDownAckRoute()}`,
    };
  },
});

export const ALREADY_ACKNOWLEDGED_NOTE =
  "This conversation had already stood down, and its one acknowledgement is spent or belongs to another turn. " +
  "Post nothing here and end the turn. Someone @mentioning you is what brings you back.";

function standDownHolderKey(bind: BindableContext, turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  try {
    return durableTurnKey(currentSessionId(bind), turnId);
  } catch {
    return undefined;
  }
}
