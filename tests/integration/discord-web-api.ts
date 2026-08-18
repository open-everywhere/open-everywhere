import { installHostFetchStub } from "./fetch-stub";

const API_PREFIX = "https://discord.com/api/v10/";

const STUB_BOT_TOKEN = "integration-stub-discord-bot-token";

export interface DiscordReactionCall {
  readonly on: boolean;
  readonly channelId: string;
  readonly messageId: string;
  readonly emoji: string;
}

export interface DiscordWebApiStub {
  readonly reactions: readonly DiscordReactionCall[];
  uninstall(): void;
}

const REACTION_PATH = /^channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/;

export function installDiscordWebApiStub(): DiscordWebApiStub {
  const reactions: DiscordReactionCall[] = [];
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, "DISCORD_BOT_TOKEN");
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = STUB_BOT_TOKEN;

  const stub = installHostFetchStub(API_PREFIX, (url, init) => {
    const path = url.href.slice(API_PREFIX.length);
    const match = REACTION_PATH.exec(path);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!match || (method !== "PUT" && method !== "DELETE")) return undefined;
    reactions.push({ on: method === "PUT", channelId: match[1]!, messageId: match[2]!, emoji: decodeURIComponent(match[3]!) });
    return new Response(null, { status: 204 });
  });

  let uninstalled = false;
  return {
    reactions,
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      stub.uninstall();
      if (hadToken) process.env.DISCORD_BOT_TOKEN = previousToken;
      else delete process.env.DISCORD_BOT_TOKEN;
    },
  };
}
