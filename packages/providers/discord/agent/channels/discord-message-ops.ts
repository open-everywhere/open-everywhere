import type { SurfaceMessageOps, OutboundFile } from "@open-everywhere/core/agent/adapter-api.js";
import { discordPostMessage } from "./discord-post.js";
import { discordFetch } from "./discord-rest.js";

const API = "https://discord.com/api/v10";

function botToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set — the bot token is required to post to Discord.");
  return token;
}

export const discordMessageOps: SurfaceMessageOps = {
  platform: "discord",
  postText(channelId, text, opts) {
    return discordPostMessage(channelId, text, opts?.replyToMessageId ? { replyToMessageId: opts.replyToMessageId } : undefined);
  },
  async editMessage(channelId, messageId, text) {
    const res = await discordFetch("PATCH /channels/{id}/messages/{id}", `${API}/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { authorization: `Bot ${botToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ components: [], content: text }),
    });
    if (!res.ok) throw new Error(`Discord edit-message failed (${res.status}) for channel ${channelId}`);
  },
  async permalink(ref) {
    const guild = ref.dm ? "@me" : ref.workspace;
    return guild ? `https://discord.com/channels/${guild}/${ref.channelId}/${ref.messageId}` : undefined;
  },
  async setReaction(channelId, messageId, emoji, on) {
    const encoded = encodeURIComponent(emoji);
    try {
      const res = await discordFetch(
        on ? "PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me" : "DELETE /channels/{id}/messages/{id}/reactions/{emoji}/@me",
        `${API}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
        { method: on ? "PUT" : "DELETE", headers: { authorization: `Bot ${botToken()}` } },
      );
      if (!res.ok && !(!on && res.status === 404)) {
        console.warn(`[open-everywhere:discord] reaction ${on ? "add" : "remove"} failed (${res.status}) for message ${messageId}`);
      }
    } catch (err) {
      console.warn(`[open-everywhere:discord] reaction ${on ? "add" : "remove"} error: ${(err as Error)?.message ?? String(err)}`);
    }
  },
  async postFiles(channelId, files: readonly OutboundFile[], comment) {
    const form = new FormData();
    const attachments = files.map((file, i) => ({ id: i, filename: file.filename, ...(file.caption ? { description: file.caption } : {}) }));
    form.append("payload_json", JSON.stringify({ ...(comment ? { content: comment } : {}), attachments }));
    files.forEach((file, i) => {
      const ab = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
      form.append(`files[${i}]`, new Blob([ab], { type: file.contentType }), file.filename);
    });
    const res = await discordFetch("POST /channels/{id}/messages", `${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${botToken()}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Discord create-message (files) failed (HTTP ${res.status}) for channel ${channelId}`);
    const body = (await res.json().catch(() => undefined)) as { id?: unknown } | undefined;
    return typeof body?.id === "string" ? body.id : undefined;
  },
};
