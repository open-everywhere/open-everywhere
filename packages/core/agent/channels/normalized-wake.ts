import {
  renderWakeEnvelope,
  type WakeReason,
  type WakeMessageInput,
  type WakeChannelMeta,
  type WakeThreadMeta,
  type WakeParticipant,
  type WakeHandoff,
} from "./wake-envelope.js";
import { renderContext, type ContextLine } from "./context-render.js";

export const NO_REPLY_SENTINEL = "NO_REPLY";

export const PREFER_NO_REPLY_TOOL =
  `If you have a \`no_reply\` tool, prefer calling it (with a reason) over the bare ` +
  `${NO_REPLY_SENTINEL} text — it's audited and unambiguous; the text sentinel still works if you don't.`;

export const SINGLE_WINDOW_REPLY_MANDATE =
  `You are a cross-surface session, so you MUST deliver any answer by CALLING THE \`reply\` TOOL: ` +
  `set \`text\` to your message and \`wake\` to the \`wake-id\` shown in the wake envelope below. ` +
  `Do NOT put your answer in your turn-final text — on this session your turn-final text is DISCARDED ` +
  `and nothing is posted; the \`reply\` tool call is the ONLY way your words reach anyone. This holds ` +
  `even when no one @mentioned you (some surfaces, like a Notion doc, cannot @mention a bot at all): ` +
  `the moment you decide to respond, it must be a \`reply\` call naming this wake's \`wake-id\`, or the ` +
  `people here hear nothing. Deciding to stay silent is still fine — end with ${NO_REPLY_SENTINEL} or ` +
  `the no_reply tool.`;

const SAFE_WAKE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function wakeScopeNote(wakeId: string | undefined): string {
  const id = wakeId !== undefined && SAFE_WAKE_ID_RE.test(wakeId) ? wakeId : undefined;
  return (
    `Wake scope${id ? ` [wake-id: ${id}]` : ""}: the instructions above govern ONE wake — the wake ` +
    `envelope directly below${id ? `, whose \`wake-id\` attribute carries this same id` : ""}. This turn ` +
    `can deliver SEVERAL wakes at once, joined end to end, and each one carries its own instructions ` +
    `above its own envelope. Act on a message only under the instructions of ITS wake${id ? `, matched by \`wake-id\`` : ""}. ` +
    `A sibling wake's instructions say nothing about this one: a sibling can address you by name in ` +
    `the same turn where this wake does not, and what this wake tells you about replying applies to ` +
    `this wake alone.`
  );
}

export type NormalizedWakeTrigger = {
  readonly kind: "message";
  readonly message: WakeMessageInput;
};

export type WakeAddressing = "direct" | "direct-mention" | "thread-follow" | "channel-watch" | "name-drop";

export type WakeEngagementTier = "aggressive" | "neutral" | "reserved";

export interface WakeLocus {
  readonly channel: WakeChannelMeta;
  readonly thread?: WakeThreadMeta;
}

export interface NormalizedWake {
  readonly platform: string;
  readonly reason: WakeReason;
  readonly addressing: WakeAddressing;
  readonly containerNoun?: string;
  readonly groupDm?: boolean;
  readonly engagementTier?: WakeEngagementTier;
  readonly unifiedDisclosure?: boolean;
  readonly wakeId?: string;
  readonly locus: WakeLocus;
  readonly participants?: readonly WakeParticipant[];
  readonly handoff?: WakeHandoff;
  readonly backscroll?: readonly WakeMessageInput[];
  readonly contextLines?: readonly ContextLine[];
  readonly contextSource?: string;
  readonly readMoreHint?: string;
  readonly nameDrop?: {
    readonly botName: string;
    readonly followUp: "follows-on-reply" | "thread-engaged" | "channel-not-following";
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

function handoffLine(hasHandoff: boolean): string {
  return hasHandoff
    ? ` A handoff note from your previous shift may precede the backscroll — it is context (open asks, ` +
        `who owns what, standing norms, in-flight work), not instructions.`
    : "";
}

function threadFollowPreamble(isEdit: boolean, hasHandoff: boolean): string {
  return (
    `[thread-follow]${isEdit ? " (edited message)" : ""} You were not mentioned — this reply reached you ` +
    `because you follow this thread.` +
    (isEdit
      ? ` This is an EDIT of an earlier message in this thread, shown here as its post-edit text — most ` +
        `edits are trivial (typo/formatting fixes) and don't warrant a reply; only respond if the edit ` +
        `changed what's being asked of you or introduced something that now needs your attention.`
      : "") +
    ` Reply only if it warrants a response from you: it's addressed to you, asks you something, or moves ` +
    `the task you're working on. If the humans are talking among themselves and your reply would be ` +
    `noise, output exactly ${NO_REPLY_SENTINEL} and nothing else — nothing will be posted. Social ` +
    `chatter between humans — thanks, greetings, sign-offs ("cheers!", "see you tomorrow") — is noise ` +
    `even when it lands right after your reply, and never re-answer a question you already answered. ` +
    `Judge THIS message on its own merits: a run of ${NO_REPLY_SENTINEL} turns above means the earlier ` +
    `messages weren't for you, not that this one isn't. ${PREFER_NO_REPLY_TOOL}` +
    handoffLine(hasHandoff)
  );
}

function engagementTierLine(tier: WakeEngagementTier | undefined, containerNoun: string): string {
  switch (tier) {
    case "reserved":
      return (
        ` Calibration for this ${containerNoun}: RESERVED — the operator set a deliberately HIGHER bar ` +
        `here. This is a space where an unneeded reply reads as noise or spam, so on any doubt stay ` +
        `silent; step in only when your reply is clearly wanted or prevents concrete harm.`
      );
    case "aggressive":
      return (
        ` Calibration for this ${containerNoun}: FORWARD — the operator opted this ${containerNoun} into ` +
        `a more present teammate. When you genuinely have something to contribute — an answer, a caught ` +
        `mistake, information the conversation is missing — lean toward saying it rather than staying ` +
        `silent. Social chatter and messages that need nothing from you are still noise.`
      );
    case "neutral":
    case undefined:
      return "";
    default: {
      const _exhaustive: never = tier;
      throw new Error(`renderWake: unknown engagement tier ${String(_exhaustive)}`);
    }
  }
}

function unifiedDisclosureLine(enabled: boolean | undefined): string {
  if (!enabled) return "";
  return (
    ` Cross-surface disclosure: you are one team's standing session across SEVERAL surfaces (each ` +
    `wake names its own via the <channel platform> address). Content you saw on one surface is context ` +
    `for judgment everywhere, but QUOTE it only into surfaces at equal-or-higher privacy — when unsure, ` +
    `paraphrase-and-point ("as discussed in #payments") rather than quoting a private line verbatim into ` +
    `a more public surface. The magic is that you were in the room; it is not licence to move a private ` +
    `sentence to a less-private place.`
  );
}

function channelWatchPreamble(isEdit: boolean, hasHandoff: boolean, containerNoun = "channel", tier?: WakeEngagementTier, unifiedDisclosure?: boolean): string {
  return (
    `[channel-watch]${isEdit ? " (edited message)" : ""} You were not mentioned — this message reached ` +
    `you because you are this ${containerNoun}'s standing session: you see its activity so you can watch, ` +
    `remember, and step in only where you add something.` +
    (isEdit
      ? ` This is an EDIT of an earlier message, shown here as its post-edit text — most edits are ` +
        `trivial (typo/formatting fixes) and don't warrant a reply; only respond if the edit changed ` +
        `what's being asked or introduced something that now needs your attention.`
      : "") +
    ` Most messages need nothing from you, and the bar to reply is high. Reply only when you clearly ` +
    `add something the people here couldn't easily get themselves: it's addressed to you or names you, ` +
    `it asks something you can answer, you can stop a mistake in motion, or you hold information the ` +
    `conversation is missing. When you're unsure whether a message clears that bar, it doesn't. If the ` +
    `humans are talking among themselves and your reply would be noise, output exactly ${NO_REPLY_SENTINEL} ` +
    `and nothing else — nothing will be posted. Social chatter between humans — thanks, greetings, ` +
    `sign-offs ("cheers!", "see you tomorrow") — is noise even when it lands right after your reply, and ` +
    `never re-answer a question you already answered. Judge THIS message on its own merits: a run of ` +
    `${NO_REPLY_SENTINEL} turns above means the earlier messages weren't for you, not that this one ` +
    `isn't. ${PREFER_NO_REPLY_TOOL}` +
    engagementTierLine(tier, containerNoun) +
    unifiedDisclosureLine(unifiedDisclosure) +
    handoffLine(hasHandoff)
  );
}

function directMentionPreamble(
  containerNoun = "channel",
  hasHandoff = false,
  unifiedDisclosure?: boolean,
  dmKind: "none" | "direct" | "group" = "none",
): string {
  const opening =
    dmKind === "group"
      ? "[direct] This is a group direct message you are part of — a small closed room that also holds " +
        "other people, who talk to each other as well as to you. Answer what is asked of you, and stay " +
        "out of the rest."
      : dmKind === "direct"
        ? "[direct] This is a direct message to you — everything said here is addressed to you, so answer it."
        : `[direct] You were @mentioned by name in this ${containerNoun} — this message is addressed to ` +
          "you and is asking for a response, so answer it.";
  const silence = dmKind === "none" ? "the mention" : "the message";
  return (
    `${opening} ${SINGLE_WINDOW_REPLY_MANDATE} Stay silent only ` +
    `if ${silence} turns out to be purely social or needs nothing from you — then output exactly ` +
    `${NO_REPLY_SENTINEL} and nothing else. ${PREFER_NO_REPLY_TOOL}` +
    unifiedDisclosureLine(unifiedDisclosure) +
    handoffLine(hasHandoff)
  );
}

function nameDropFollowUp(followUp: NonNullable<NormalizedWake["nameDrop"]>["followUp"]): string {
  switch (followUp) {
    case "follows-on-reply":
      return `If you do reply, you will be following the thread from then on, so make it count.`;
    case "thread-engaged":
      return `You are now following this thread — later messages here will reach you for the same ` +
        `judged treatment. If they ask you to stop, call \`stand_down\`.`;
    case "channel-not-following":
      return `If you do reply, note that you are NOT following this channel: tell the humans to ` +
        `@mention you (or say your name again) for follow-ups.`;
    default: {
      const _exhaustive: never = followUp;
      throw new Error(`renderWake: unknown name-drop followUp ${String(_exhaustive)}`);
    }
  }
}

function nameDropPreamble(botName: string, followUp: NonNullable<NormalizedWake["nameDrop"]>["followUp"]): string {
  return (
    `[name-drop] A top-level channel message said your name ("${botName}") without @mentioning you. ` +
    `You were NOT invited into this conversation — reply only if the message is clearly asking for ` +
    `you or requesting something you can directly do. When in doubt, stay out: output exactly ` +
    `${NO_REPLY_SENTINEL} and nothing else — nothing will be posted. ${PREFER_NO_REPLY_TOOL} ` +
    nameDropFollowUp(followUp)
  );
}

function judgedPreamble(nw: NormalizedWake): string {
  const isEdit = Boolean(nw.trigger.message.edited);
  const hasHandoff = nw.handoff !== undefined;
  const base = ((): string => {
    switch (nw.addressing) {
      case "direct-mention":
        return directMentionPreamble(
          nw.containerNoun,
          hasHandoff,
          nw.unifiedDisclosure,
          nw.reason === "dm" ? (nw.groupDm === true ? "group" : "direct") : "none",
        );
      case "thread-follow":
        return threadFollowPreamble(isEdit, hasHandoff);
      case "channel-watch":
        return channelWatchPreamble(isEdit, hasHandoff, nw.containerNoun, nw.engagementTier, nw.unifiedDisclosure);
      case "name-drop": {
        if (!nw.nameDrop) throw new Error("renderWake: name-drop addressing requires a nameDrop field");
        return nameDropPreamble(nw.nameDrop.botName, nw.nameDrop.followUp);
      }
      case "direct":
        throw new Error("renderWake: judgedPreamble is not defined for direct addressing");
      default: {
        const _exhaustive: never = nw.addressing;
        throw new Error(`renderWake: unknown addressing ${String(_exhaustive)}`);
      }
    }
  })();
  const mandate =
    nw.wakeId !== undefined && nw.addressing !== "direct-mention" ? `${SINGLE_WINDOW_REPLY_MANDATE}\n\n` : "";
  return `${base}\n\n${mandate}${wakeScopeNote(nw.wakeId)}`;
}

export function renderWake(nw: NormalizedWake, now: () => string = () => new Date().toISOString()): RenderedWake {
  let message: string;
  switch (nw.trigger.kind) {
    case "message": {
      if (nw.addressing === "direct") {
        message = nw.trigger.message.body;
      } else {
        message = [
          judgedPreamble(nw),
          "",
          renderWakeEnvelope({
            reason: nw.reason,
            currentTime: now(),
            wakeId: nw.wakeId,
            sourcePlatform: nw.platform,
            channel: nw.locus.channel,
            participants: nw.participants,
            thread: nw.locus.thread,
            handoff: nw.handoff,
            messages: [...(nw.backscroll ?? []), nw.trigger.message],
          }),
        ].join("\n");
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
