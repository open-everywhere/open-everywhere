import { installHostFetchStub } from "./fetch-stub";

const API_PREFIX = "https://discord.com/api/v10/";

const STUB_BOT_TOKEN = "integration-stub-discord-bot-token";

export interface DiscordReactionCall {
  readonly on: boolean;
  readonly channelId: string;
  readonly messageId: string;
  readonly emoji: string;
}

export interface DiscordCreateMessageCall {
  readonly channelId: string;
  readonly content: string;
  readonly components: readonly Record<string, unknown>[];
  readonly replyTo?: string;
}

export interface InstallDiscordWebApiStubOptions {
  readonly captureMessages?: boolean;
}

export interface DiscordWebApiStub {
  readonly reactions: readonly DiscordReactionCall[];
  readonly messages: readonly DiscordCreateMessageCall[];
  uninstall(): void;
}

const REACTION_PATH = /^channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/;

const CREATE_MESSAGE_PATH = /^channels\/([^/]+)\/messages$/;

export function installDiscordWebApiStub(options: InstallDiscordWebApiStubOptions = {}): DiscordWebApiStub {
  const reactions: DiscordReactionCall[] = [];
  const messages: DiscordCreateMessageCall[] = [];
  let nextMessageId = 1;
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, "DISCORD_BOT_TOKEN");
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = STUB_BOT_TOKEN;

  const stub = installHostFetchStub(API_PREFIX, (url, init) => {
    const path = url.href.slice(API_PREFIX.length);
    const method = (init?.method ?? "GET").toUpperCase();
    if (options.captureMessages && method === "POST") {
      const created = CREATE_MESSAGE_PATH.exec(path);
      if (created) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { content?: unknown; components?: unknown; message_reference?: { message_id?: unknown } };
        const replyTo = body.message_reference?.message_id;
        messages.push({
          channelId: created[1]!,
          content: typeof body.content === "string" ? body.content : "",
          components: Array.isArray(body.components) ? (body.components as Record<string, unknown>[]) : [],
          ...(typeof replyTo === "string" ? { replyTo } : {}),
        });
        return Response.json({ id: `stub-message-${nextMessageId++}` }, { status: 200 });
      }
    }
    const match = REACTION_PATH.exec(path);
    if (!match || (method !== "PUT" && method !== "DELETE")) return undefined;
    reactions.push({ on: method === "PUT", channelId: match[1]!, messageId: match[2]!, emoji: decodeURIComponent(match[3]!) });
    return new Response(null, { status: 204 });
  });

  let uninstalled = false;
  return {
    reactions,
    messages,
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      stub.uninstall();
      if (hadToken) process.env.DISCORD_BOT_TOKEN = previousToken;
      else delete process.env.DISCORD_BOT_TOKEN;
    },
  };
}
