import {
  renderWakeEnvelope,
  type WakeReason,
  type WakeMessageInput,
  type WakeChannelMeta,
  type WakeThreadMeta,
  type WakeParticipant,
  type WakeAddressing,
  type WakeEngagementTier,
  type WakeFollowUp,
} from "./wake-envelope.js";
import { renderContext, type ContextLine } from "./context-render.js";
import { encodeChannelKey } from "./channel-key.js";

export type { WakeAddressing, WakeEngagementTier } from "./wake-envelope.js";

export const NO_REPLY_SENTINEL = "NO_REPLY";

export const END_TURN_WITH_SENTINEL_INSTRUCTION = `Now end the turn: output exactly ${NO_REPLY_SENTINEL} and nothing else.`;

export const PREFER_NO_REPLY_TOOL =
  `If you have a \`no_reply\` tool, prefer calling it (with a reason) over the bare ` +
  `${NO_REPLY_SENTINEL} text — it's audited and unambiguous; the text sentinel still works if you don't.`;

export type NormalizedWakeTrigger = {
  readonly kind: "message";
  readonly message: WakeMessageInput;
};

export interface WakeLocus {
  readonly channel: WakeChannelMeta;
  readonly thread?: WakeThreadMeta;
}

export interface NormalizedWake {
  readonly platform: string;
  readonly reason: WakeReason;
  readonly addressing: WakeAddressing;
  readonly containerNoun?: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly wakeId?: string;
  readonly followUp?: WakeFollowUp;
  readonly locus: WakeLocus;
  readonly participants?: readonly WakeParticipant[];
  readonly backscroll?: readonly WakeMessageInput[];
  readonly contextLines?: readonly ContextLine[];
  readonly contextSource?: string;
  readonly readMoreHint?: string;
  readonly nameDrop?: {
    readonly followUp: WakeFollowUp;
  };
  readonly memoryDelta?: string;
  readonly trigger: NormalizedWakeTrigger;
}

export interface RenderedWake {
  readonly message: string;
  readonly context?: readonly string[];
}

export type WakeIngest<Raw> = (raw: Raw) => NormalizedWake | null;

export function mkMessageTrigger(message: WakeMessageInput): NormalizedWakeTrigger {
  return { kind: "message", message: { ...message, trigger: true } };
}

export function renderWake(nw: NormalizedWake, now: () => string = () => new Date().toISOString()): RenderedWake {
  let message: string;
  switch (nw.trigger.kind) {
    case "message": {
      if (nw.addressing === "direct") {
        message = nw.trigger.message.body;
      } else {
        message = renderWakeEnvelope({
            reason: nw.reason,
            currentTime: now(),
            wakeId: nw.wakeId,
            addressing: nw.addressing,
            engagement: nw.engagementTier,
            followUp: nw.nameDrop?.followUp ?? nw.followUp,
            sourcePlatform: nw.platform,
            channel: {
              ...nw.locus.channel,
              id: encodeChannelKey(nw.platform, nw.locus.channel.id),
              container: nw.locus.channel.container ?? nw.containerNoun ?? "channel",
            },
            participants: nw.participants,
            thread: nw.locus.thread,
            messages: [...(nw.backscroll ?? []), nw.trigger.message],
        });
      }
      break;
    }
    default: {
      const _exhaustive: never = nw.trigger.kind;
      throw new Error(`renderWake: unknown trigger kind ${String(_exhaustive)}`);
    }
  }

  if (nw.memoryDelta !== undefined && nw.addressing !== "direct") {
    message = `${message}\n\n${nw.memoryDelta}`;
  }

  if (nw.contextLines && nw.contextLines.length > 0) {
    const rendered = renderContext(nw.contextLines, nw.contextSource ?? "", { readMoreHint: nw.readMoreHint });
    if (rendered) return { message, context: [rendered] };
  }
  return { message };
}
