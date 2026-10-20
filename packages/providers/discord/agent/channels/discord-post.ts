import { markNotApplied } from "@open-everywhere/core/agent/adapter-api.js";
import { discordBotToken } from "./discord-credentials.js";
import { discordFetch } from "./discord-rest.js";

const API = "https://discord.com/api/v10";

export const DISCORD_MESSAGE_MAX = 2000;

function botHeaders(token: string): Record<string, string> {
  return { authorization: `Bot ${token}`, "content-type": "application/json" };
}

async function botToken(): Promise<string> {
  const token = await discordBotToken();
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set — the reply tool needs the bot token to post to Discord.");
  }
  return token;
}

export function splitForDiscord(text: string, max = DISCORD_MESSAGE_MAX): string[] {
  if (text.length <= max) return [text];
  const bare = splitRespectingFences(text, max);
  if (bare.length <= 2) return bare;
  const numbered = splitRespectingFences(text, max - NUMBER_HEADER_RESERVE);
  const n = numbered.length;
  return numbered.map((part, i) => `[${i + 1}/${n}]\n${part}`);
}

const NUMBER_HEADER_RESERVE = 12;
const FENCE_CLOSE = "\n```";
const FENCE_LINE = /^\s*```/;

function fenceStateAfter(start: string | null, body: string): string | null {
  let opener = start;
  for (const line of body.split("\n")) {
    if (FENCE_LINE.test(line)) opener = opener === null ? line.trim() : null;
  }
  return opener;
}

function chooseCut(text: string, from: number, hardEnd: number): { end: number; drop: number } {
  if (hardEnd >= text.length) return { end: text.length, drop: 0 };
  const nl = text.lastIndexOf("\n", hardEnd);
  if (nl > from) return { end: nl, drop: 1 };
  let sentence = -1;
  for (const sep of [". ", "! ", "? "]) {
    const i = text.lastIndexOf(sep, hardEnd - 1);
    if (i > from && i + 1 < hardEnd) sentence = Math.max(sentence, i + 1);
  }
  if (sentence > from) return { end: sentence, drop: 1 };
  const sp = text.lastIndexOf(" ", hardEnd);
  if (sp > from) return { end: sp, drop: 1 };
  return { end: hardEnd, drop: 0 };
}

function splitRespectingFences(text: string, renderBudget: number): string[] {
  const parts: string[] = [];
  let carried: string | null = null;
  let pos = 0;
  while (pos < text.length) {
    const reopen = carried !== null ? `${carried}\n` : "";
    const avail = Math.max(1, renderBudget - reopen.length);
    let cut = chooseCut(text, pos, Math.min(pos + avail, text.length));
    let body = text.slice(pos, cut.end);
    let endOpener = fenceStateAfter(carried, body);
    let suffix = endOpener !== null ? FENCE_CLOSE : "";
    if (reopen.length + body.length + suffix.length > renderBudget && body.length > 1) {
      cut = chooseCut(text, pos, Math.min(pos + avail - suffix.length, text.length));
      body = text.slice(pos, cut.end);
      endOpener = fenceStateAfter(carried, body);
      suffix = endOpener !== null ? FENCE_CLOSE : "";
    }
    parts.push(`${reopen}${body}${suffix}`);
    carried = endOpener;
    pos = cut.end + cut.drop;
  }
  return parts;
}

export async function discordPostMessage(channelId: string, content: string, opts?: { replyToMessageId?: string }): Promise<string> {
  const parts = splitForDiscord(content);
  let firstId: string | undefined;
  for (const part of parts) {
    if (!part.trim()) continue;
    const id = await discordPostOne(channelId, part, firstId === undefined ? opts?.replyToMessageId : undefined);
    firstId ??= id;
  }
  if (firstId === undefined) {
    throw markNotApplied(new Error(`Discord create-message had no content to post for channel ${channelId}`));
  }
  return firstId;
}

export async function discordOpenDmChannel(userId: string): Promise<string> {
  const res = await discordFetch("POST /users/@me/channels", `${API}/users/@me/channels`, {
    method: "POST",
    headers: botHeaders(await botToken()),
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!res.ok) {
    throw markNotApplied(
      Object.assign(new Error(`Discord could not open a DM channel (${res.status}) with user ${userId}`), { status: res.status }),
    );
  }
  const body = (await res.json()) as { id?: unknown };
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) throw markNotApplied(new Error(`Discord open-DM returned no channel id for user ${userId}`));
  return id;
}

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_SUCCESS = 3;
const BUTTON_STYLE_DANGER = 4;

export interface DiscordDmButton {
  readonly customId: string;
  readonly label: string;
  readonly intent: "affirm" | "reject";
}

export async function discordPostMessageWithButtons(
  channelId: string,
  content: string,
  buttons: readonly DiscordDmButton[],
): Promise<string> {
  if (content.length > DISCORD_MESSAGE_MAX) {
    throw markNotApplied(
      new Error(`Discord create-message with buttons cannot split ${content.length} characters (cap ${DISCORD_MESSAGE_MAX}) for channel ${channelId}`),
    );
  }
  const res = await discordFetch("POST /channels/{id}/messages", `${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: botHeaders(await botToken()),
    body: JSON.stringify({
      content,
      components: [
        {
          type: COMPONENT_ACTION_ROW,
          components: buttons.map((b) => ({
            type: COMPONENT_BUTTON,
            style: b.intent === "affirm" ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_DANGER,
            label: b.label,
            custom_id: b.customId,
          })),
        },
      ],
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Discord create-message with buttons failed (${res.status}) for channel ${channelId}`), { status: res.status });
  }
  const body = (await res.json()) as { id?: unknown };
  const id = typeof body?.id === "string" ? body.id : undefined;
  if (!id) throw new Error(`Discord create-message with buttons returned no message id for channel ${channelId}`);
  return id;
}

async function discordPostOne(channelId: string, content: string, replyToMessageId?: string): Promise<string> {
  const res = await discordFetch("POST /channels/{id}/messages", `${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: botHeaders(await botToken()),
    body: JSON.stringify({
      content,
      ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } } : {}),
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Discord create-message failed (${res.status}) for channel ${channelId}`), { status: res.status });
  }
  const body = (await res.json()) as { id?: unknown };
  const id = typeof body?.id === "string" ? body.id : undefined;
  if (!id) throw new Error(`Discord create-message returned no message id for channel ${channelId}`);
  return id;
}

export async function discordEditMessage(channelId: string, messageId: string, content: string): Promise<void> {
  if (content.length > DISCORD_MESSAGE_MAX) {
    throw markNotApplied(
      new Error(
        `edit_reply couldn't update the Discord message — the new text is ${content.length} characters and Discord caps one message at ${DISCORD_MESSAGE_MAX}. A message cannot be split by an edit; shorten it, or post a new reply.`,
      ),
    );
  }
  const res = await discordFetch("PATCH /channels/{id}/messages/{id}", `${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: botHeaders(await botToken()),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`edit_reply couldn't update the Discord message (${res.status}) in channel ${channelId}`), {
      status: res.status,
    });
  }
}

const DISCORD_EMOJI_MAP: Readonly<Record<string, string>> = {
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  eyes: "👀",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  tada: "🎉",
  rocket: "🚀",
  heart: "❤️",
  fire: "🔥",
  clap: "👏",
  wave: "👋",
  raised_hand: "✋",
  raised_hands: "🙌",
  pray: "🙏",
  laughing: "😆",
  joy: "😂",
  confused: "😕",
  thinking_face: "🤔",
  hourglass: "⏳",
  hourglass_flowing_sand: "⏳",
  question: "❓",
  exclamation: "❗",
  warning: "⚠️",
  octagonal_sign: "🛑",
  "100": "💯",
};

export async function discordAddReaction(channelId: string, messageId: string, emojiName: string): Promise<void> {
  const unicode = DISCORD_EMOJI_MAP[emojiName.toLowerCase()];
  if (!unicode) {
    throw markNotApplied(
      new Error(
        `react couldn't post to Discord — "${emojiName}" has no Discord emoji equivalent here; this deployment supports: ${Object.keys(DISCORD_EMOJI_MAP).join(", ")}.`,
      ),
    );
  }
  const res = await discordFetch(
    "PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me",
    `${API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(unicode)}/@me`,
    { method: "PUT", headers: botHeaders(await botToken()) },
  );
  if (!res.ok) {
    throw Object.assign(new Error(`react couldn't post to Discord — ${res.status} on channel ${channelId}`), { status: res.status });
  }
}

export async function discordExistingThreadForMessage(channelId: string, messageId: string): Promise<string | null> {
  try {
    const msgRes = await discordFetch("GET /channels/{id}/messages/{id}", `${API}/channels/${channelId}/messages/${messageId}`, {
      headers: botHeaders(await botToken()),
    });
    if (!msgRes.ok) return null;
    const msg = (await msgRes.json()) as { thread?: { id?: unknown } };
    return typeof msg?.thread?.id === "string" ? msg.thread.id : null;
  } catch {
    return null;
  }
}

export async function discordThreadForMessage(channelId: string, messageId: string, name: string): Promise<string | null> {
  try {
    const res = await discordFetch(
      "POST /channels/{id}/messages/{id}/threads",
      `${API}/channels/${channelId}/messages/${messageId}/threads`,
      {
        method: "POST",
        headers: botHeaders(await botToken()),
        body: JSON.stringify({ name: name.slice(0, 100) || "thread", auto_archive_duration: 1440 }),
      },
    );
    if (res.ok) {
      const body = (await res.json()) as { id?: unknown };
      return typeof body?.id === "string" ? body.id : null;
    }
    return await discordExistingThreadForMessage(channelId, messageId);
  } catch {
    return null;
  }
}

