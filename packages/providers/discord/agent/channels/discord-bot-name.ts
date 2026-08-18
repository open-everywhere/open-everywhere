import type { BotDisplayNameArm } from "@open-everywhere/core/agent/adapter-api.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type DiscordSelfRequester = () => Promise<unknown>;

const liveDiscordSelfRequest: DiscordSelfRequester = async () => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("bot-display-name: DISCORD_BOT_TOKEN is not set.");
  const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`bot-display-name: Discord GET /users/@me failed (HTTP ${res.status}).`);
  return res.json();
};

interface DiscordSelfUser {
  readonly username?: unknown;
  readonly global_name?: unknown;
}

function trimmedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function discordBotDisplayNameViaRest(req: DiscordSelfRequester): Promise<string | undefined> {
  try {
    const json = (await req()) as DiscordSelfUser | null;
    return trimmedName(json?.global_name) ?? trimmedName(json?.username);
  } catch {
    return undefined;
  }
}

let handlePromise: Promise<string | undefined> | undefined;

export const discordBotDisplayName: BotDisplayNameArm = () => {
  if (!handlePromise) {
    handlePromise = (async () => {
      try {
        const timeout = new Promise<undefined>((resolve) => {
          const t = setTimeout(() => resolve(undefined), 5000);
          t.unref?.();
        });
        return await Promise.race([discordBotDisplayNameViaRest(liveDiscordSelfRequest), timeout]);
      } catch {
        return undefined;
      }
    })();
  }
  return handlePromise;
};

export function _resetDiscordBotDisplayNameForTest(): void {
  handlePromise = undefined;
}
