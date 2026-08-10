import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import type { Partition } from "../memory/partition.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export type EmojiClass = "positive" | "negative" | "other";

const POSITIVE_EMOJI: ReadonlySet<string> = new Set([
  "thumbsup", "+1", "white_check_mark", "heavy_check_mark", "ballot_box_with_check",
  "heart", "hearts", "yellow_heart", "green_heart", "blue_heart", "purple_heart",
  "tada", "raised_hands", "clap", "fire", "100", "pray", "star", "star2", "ok_hand",
  "muscle", "rocket", "smile", "smiley", "grinning", "joy", "sunglasses", "the_horns",
  "👍", "✅", "✔", "❤", "🧡", "💛", "💚", "💙", "💜", "🎉", "🙌", "👏", "🔥", "💯",
  "🙏", "⭐", "🌟", "👌", "💪", "🚀", "😄", "😀", "😁", "😂", "🤣", "😎",
]);

const NEGATIVE_EMOJI: ReadonlySet<string> = new Set([
  "thumbsdown", "-1", "x", "negative_squared_cross_mark", "no_entry", "no_entry_sign",
  "rage", "angry", "cry", "sob", "disappointed", "poop", "hankey", "confused", "no_good",
  "-1_tone", "warning",
  "👎", "❌", "⛔", "🚫", "😡", "😠", "😢", "😭", "😞", "💩", "😕", "🙅", "⚠",
]);

export function classifyEmoji(raw: string): EmojiClass {
  const name = raw
    .split("::")[0]
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    .trim()
    .toLowerCase();
  if (POSITIVE_EMOJI.has(name)) return "positive";
  if (NEGATIVE_EMOJI.has(name)) return "negative";
  return "other";
}

export type ReactionSurface = "slack" | "discord";
export type ReactionVerb = "added" | "removed";

const REACTION_SURFACE_REGISTRY = new Set<string>();

export function registerReactionSurface(platform: string): void {
  if (!admitProviderRegistration(platform, "reaction-surface")) return;
  REACTION_SURFACE_REGISTRY.add(platform);
}

export function isRegisteredReactionSurface(platform: string): boolean {
  return REACTION_SURFACE_REGISTRY.has(platform);
}

export function registeredReactionSurfaces(): readonly string[] {
  return [...REACTION_SURFACE_REGISTRY];
}

export interface IngestedReaction {
  readonly surface: ReactionSurface;
  readonly verb: ReactionVerb;
  readonly reactorId: string;
  readonly emoji: string;
  readonly emojiClass: EmojiClass;
  readonly target: { readonly channelId: string; readonly messageId: string };
  readonly onBotReply: boolean;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surfaceKey: string;
}

export function buildIngestedReaction(input: {
  readonly surface: ReactionSurface;
  readonly verb: ReactionVerb;
  readonly reactorId: string;
  readonly emoji: string;
  readonly target: { readonly channelId: string; readonly messageId: string };
  readonly onBotReply: boolean;
  readonly partition: Pick<Partition, "org" | "platform" | "workspace" | "surfaceKey">;
}): IngestedReaction {
  return {
    surface: input.surface,
    verb: input.verb,
    reactorId: input.reactorId,
    emoji: input.emoji,
    emojiClass: classifyEmoji(input.emoji),
    target: input.target,
    onBotReply: input.onBotReply,
    org: input.partition.org,
    platform: input.partition.platform,
    workspace: input.partition.workspace,
    surfaceKey: input.partition.surfaceKey,
  };
}

export interface ReactionSinkDeps {
  readonly record: (r: IngestedReaction, atIso: string) => Promise<void>;
  readonly telemetry: (r: IngestedReaction) => void;
  readonly negativeOnBotReply?: (r: IngestedReaction) => Promise<void>;
  readonly now?: () => string;
}

export interface ReactionIngestOutcome {
  readonly recorded: boolean;
  readonly onBotReply: boolean;
  readonly reason: string;
}

export const REACTION_FEEDBACK_ACTION = "reaction.feedback";

export async function ingestReaction(r: IngestedReaction, deps: ReactionSinkDeps): Promise<ReactionIngestOutcome> {
  deps.telemetry(r);
  if (r.verb === "added" && r.emojiClass === "negative" && r.onBotReply && deps.negativeOnBotReply) {
    await deps.negativeOnBotReply(r);
  }
  if (!r.onBotReply) {
    return { recorded: false, onBotReply: false, reason: "reaction not on the bot's own message — telemetry only" };
  }
  const at = deps.now?.() ?? new Date().toISOString();
  await deps.record(r, at);
  return { recorded: true, onBotReply: true, reason: `reaction ${r.verb} on a bot reply — feedback recorded` };
}

export function emitReactionTelemetry(r: IngestedReaction): void {
  emitTelemetry(r.verb === "added" ? "oe.reaction.added" : "oe.reaction.removed", {
    "oe.surface": r.surface,
    "oe.on_bot_reply": r.onBotReply,
    "oe.emoji_class": r.emojiClass,
  });
}

export function liveReactionSink(): ReactionSinkDeps {
  return {
    record: (r, atIso) =>
      appendAudit({
        ts: atIso,
        org: r.org,
        platform: r.platform,
        workspace: r.workspace,
        surface: r.surfaceKey,
        principalId: r.reactorId,
        action: REACTION_FEEDBACK_ACTION,
        detail: {
          surface: r.surface,
          verb: r.verb,
          emoji: r.emoji,
          emojiClass: r.emojiClass,
          channelId: r.target.channelId,
          messageId: r.target.messageId,
          onBotReply: true,
        },
      }),
    telemetry: emitReactionTelemetry,
  };
}
