import type { SurfaceMessageOps, OutboundFile } from "@open-everywhere/core/agent/adapter-api.js";
import { discordPostMessage } from "./discord-post.js";

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
    const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { authorization: `Bot ${botToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`Discord edit-message failed (${res.status}) for channel ${channelId}`);
  },
  async permalink(ref) {
    const guild = ref.dm ? "@me" : ref.workspace;
    return guild ? `https://discord.com/channels/${guild}/${ref.channelId}/${ref.messageId}` : undefined;
  },
  async postFiles(channelId, files: readonly OutboundFile[], comment) {
    const form = new FormData();
    const attachments = files.map((file, i) => ({ id: i, filename: file.filename, ...(file.caption ? { description: file.caption } : {}) }));
    form.append("payload_json", JSON.stringify({ ...(comment ? { content: comment } : {}), attachments }));
    files.forEach((file, i) => {
      const ab = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
      form.append(`files[${i}]`, new Blob([ab], { type: file.contentType }), file.filename);
    });
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${botToken()}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Discord create-message (files) failed (HTTP ${res.status}) for channel ${channelId}`);
  },
};
