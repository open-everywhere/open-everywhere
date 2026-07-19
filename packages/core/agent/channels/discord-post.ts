const API = "https://discord.com/api/v10";

function botHeaders(token: string): Record<string, string> {
  return { authorization: `Bot ${token}`, "content-type": "application/json" };
}

function botToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set — the reply tool needs the bot token to post to Discord.");
  }
  return token;
}

export function splitForDiscord(text: string, max = 2000): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export async function discordPostMessage(channelId: string, content: string, opts?: { replyToMessageId?: string }): Promise<string> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: botHeaders(botToken()),
    body: JSON.stringify({
      content,
      ...(opts?.replyToMessageId ? { message_reference: { message_id: opts.replyToMessageId, fail_if_not_exists: false } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Discord create-message failed (${res.status}) for channel ${channelId}`);
  const body = (await res.json()) as { id?: unknown };
  const id = typeof body?.id === "string" ? body.id : undefined;
  if (!id) throw new Error(`Discord create-message returned no message id for channel ${channelId}`);
  return id;
}

export async function discordThreadForMessage(channelId: string, messageId: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}/threads`, {
      method: "POST",
      headers: botHeaders(botToken()),
      body: JSON.stringify({ name: name.slice(0, 100) || "thread", auto_archive_duration: 1440 }),
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: unknown };
      return typeof body?.id === "string" ? body.id : null;
    }
    const msgRes = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
      headers: botHeaders(botToken()),
    });
    if (!msgRes.ok) return null;
    const msg = (await msgRes.json()) as { thread?: { id?: unknown } };
    return typeof msg?.thread?.id === "string" ? msg.thread.id : null;
  } catch {
    return null;
  }
}

