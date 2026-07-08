import { createHmac } from "node:crypto";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const INGEST_URL = process.env.OE_INGEST_URL;
const RELAY_SECRET = process.env.OE_RELAY_SECRET;
const GUILD_ALLOWLIST = (process.env.DISCORD_GUILD_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_DRIVER_IDS = new Set(
  (process.env.OE_TEST_DRIVER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((pair) => /^\d+:\d+$/.test(pair)),
);
const isDriverAllowlisted = (message) =>
  Boolean(message.guildId) && TEST_DRIVER_IDS.has(`${message.guildId}:${message.author.id}`);

const LOG_SHIP_URL = process.env.OE_LOG_SHIP_URL;
const LOG_SHIP_TOKEN = process.env.OE_LOG_SHIP_TOKEN;
const LOG_SHIP_TOKEN_HEADER = process.env.OE_LOG_SHIP_TOKEN_HEADER || "authorization";
const LOG_SHIP_BATCH_MAX = Number(process.env.OE_LOG_SHIP_BATCH_MAX) > 0 ? Number(process.env.OE_LOG_SHIP_BATCH_MAX) : 20;
const LOG_SHIP_FLUSH_MS = Number(process.env.OE_LOG_SHIP_FLUSH_MS) > 0 ? Number(process.env.OE_LOG_SHIP_FLUSH_MS) : 1000;
let logQueue = [];
let logFlushTimer;
async function flushLogs() {
  if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = undefined; }
  if (!LOG_SHIP_URL || logQueue.length === 0) return;
  const batch = logQueue;
  logQueue = [];
  try {
    const headers = { "content-type": "application/json" };
    if (LOG_SHIP_TOKEN) headers[LOG_SHIP_TOKEN_HEADER] = LOG_SHIP_TOKEN;
    await fetch(LOG_SHIP_URL, { method: "POST", headers, body: JSON.stringify(batch) });
  } catch {
  }
}
function ship(level, message, fields = {}) {
  if (!LOG_SHIP_URL) return;
  const err = fields.err;
  delete fields.err;
  const record = {
    ...fields,
    ts: new Date().toISOString(),
    level,
    service: process.env.OE_LOG_SERVICE || "oe-discord-relay",
    env: process.env.RAILWAY_ENVIRONMENT_NAME || "railway",
    component: "discord-relay",
    message,
  };
  if (err) record.error = { name: err.name ?? "Error", message: err.message ?? String(err), stack: err.stack };
  logQueue.push(record);
  if (logQueue.length > 500) logQueue.splice(0, logQueue.length - 500);
  if (logQueue.length >= LOG_SHIP_BATCH_MAX) void flushLogs();
  else if (!logFlushTimer) { logFlushTimer = setTimeout(() => void flushLogs(), LOG_SHIP_FLUSH_MS); logFlushTimer.unref?.(); }
}
for (const [name, level] of [["log", "info"], ["warn", "warn"], ["error", "error"]]) {
  const original = console[name].bind(console);
  console[name] = (...args) => {
    try {
      const errArg = args.find((a) => a instanceof Error);
      const message = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
        .join(" ")
        .replace(/^\[oe-discord-relay\]\s*/, "");
      ship(level, message, errArg ? { err: errArg } : {});
    } catch {
    }
    original(...args);
  };
}
process.on("uncaughtExceptionMonitor", (err, origin) => {
  ship("error", `uncaught (${origin})`, { err });
  void flushLogs();
});
process.on("beforeExit", () => void flushLogs());

if (!TOKEN) {
  console.error("[oe-discord-relay] DISCORD_BOT_TOKEN is required — exiting.");
  process.exit(1);
}
if (INGEST_URL && !RELAY_SECRET) {
  console.error(
    "[oe-discord-relay] OE_INGEST_URL is set but OE_RELAY_SECRET is not — refusing to forward unsigned. Set OE_RELAY_SECRET (must match the deploy) or unset OE_INGEST_URL for proof mode.",
  );
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

function toPayload(message) {
  return {
    source: "discord-gateway-relay",
    event: "MESSAGE_CREATE",
    message: {
      id: message.id,
      content: message.content,
      createdTimestamp: message.createdTimestamp,
      channelId: message.channelId,
      channelType: message.channel?.type,
      guildId: message.guildId ?? undefined,
      author: {
        id: message.author.id,
        username: message.author.username,
        bot: message.author.bot,
      },
      mentionsBot: client.user ? message.mentions.users.has(client.user.id) : false,
      referencedMessageId: message.reference?.messageId ?? undefined,
      bot: client.user
        ? {
            id: client.user.id,
            name: message.guild?.members?.me?.displayName ?? client.user.displayName ?? client.user.username,
          }
        : undefined,
    },
  };
}

function toReactionPayload(verb, reaction, user, message) {
  return {
    source: "discord-gateway-relay",
    event: verb === "added" ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE",
    reaction: {
      verb,
      messageId: message?.id ?? reaction.message?.id,
      channelId: message?.channelId ?? reaction.message?.channelId,
      guildId: message?.guildId ?? reaction.message?.guildId ?? undefined,
      channelType: message?.channel?.type ?? reaction.message?.channel?.type,
      emoji: reaction.emoji?.name ?? "",
      reactorId: user.id,
      messageAuthorId: message?.author?.id ?? undefined,
      botId: client.user?.id,
    },
  };
}

async function handleReaction(verb, reaction, user) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message;
    if (message?.partial) {
      try {
        await message.fetch();
      } catch {
      }
    }
    const guildId = message?.guildId ?? reaction.message?.guildId ?? undefined;
    if (GUILD_ALLOWLIST.length && guildId && !GUILD_ALLOWLIST.includes(guildId)) return;
    if (!INGEST_URL) {
      const where = guildId ? `guild ${guildId}#${message?.channelId}` : `DM ${message?.channelId}`;
      console.log(`[oe-discord-relay] reaction ${verb} ${where} @${user.username}: ${reaction.emoji?.name ?? "?"}`);
      return;
    }
    await forward(toReactionPayload(verb, reaction, user, message));
  } catch (err) {
    console.warn(`[oe-discord-relay] reaction ${verb} handling error:`, err?.message ?? err);
  }
}

async function forward(payload) {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", RELAY_SECRET).update(body).digest("hex");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oe-relay-signature": signature,
        },
        body,
      });
      if (res.ok) return;
      if (res.status !== 429 && res.status < 500) {
        console.error(`[oe-discord-relay] ingest rejected ${res.status} — dropping message ${payload.message.id}`);
        return;
      }
      console.warn(`[oe-discord-relay] ingest ${res.status} (attempt ${attempt}/3)`);
    } catch (err) {
      console.warn(`[oe-discord-relay] ingest error (attempt ${attempt}/3):`, err?.message ?? err);
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  console.error(`[oe-discord-relay] gave up forwarding message ${payload.message.id} after 3 attempts`);
}

client.once(Events.ClientReady, (c) => {
  const mode = INGEST_URL ? `FORWARD → ${INGEST_URL}` : "PROOF (log only — set OE_INGEST_URL to forward)";
  const guilds = [...c.guilds.cache.values()].map((g) => `${g.name} (${g.id})`).join(", ") || "none yet";
  console.log(`[oe-discord-relay] ready as ${c.user.tag} | mode: ${mode}`);
  console.log(`[oe-discord-relay] in guilds: ${guilds}`);
  if (GUILD_ALLOWLIST.length) console.log(`[oe-discord-relay] guild allowlist active: ${GUILD_ALLOWLIST.join(", ")}`);
  if (TEST_DRIVER_IDS.size)
    console.log(`[oe-discord-relay] e2e driver seam ARMED for ${TEST_DRIVER_IDS.size} pair(s) — bot messages from these ids are forwarded`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot && !isDriverAllowlisted(message)) return;
  if (GUILD_ALLOWLIST.length && message.guildId && !GUILD_ALLOWLIST.includes(message.guildId)) return;

  if (!INGEST_URL) {
    const where = message.guildId ? `guild ${message.guildId}#${message.channelId}` : `DM ${message.channelId}`;
    const content = message.content?.length ? message.content : "(empty — is Message Content Intent enabled?)";
    console.log(`[oe-discord-relay] ${where} @${message.author.username}: ${content}`);
    return;
  }
  await forward(toPayload(message));
});

client.on(Events.MessageReactionAdd, (reaction, user) => void handleReaction("added", reaction, user));
client.on(Events.MessageReactionRemove, (reaction, user) => void handleReaction("removed", reaction, user));

client.on(Events.Error, (err) => console.error("[oe-discord-relay] client error:", err?.message ?? err));
client.on(Events.ShardDisconnect, (_e, id) => console.warn(`[oe-discord-relay] shard ${id} disconnected — discord.js will reconnect`));
client.on(Events.ShardResume, (id) => console.log(`[oe-discord-relay] shard ${id} resumed`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[oe-discord-relay] ${sig} — closing gateway`);
    client.destroy().finally(() => flushLogs().finally(() => process.exit(0)));
  });
}

client.login(TOKEN).catch((err) => {
  console.error("[oe-discord-relay] login failed:", err?.message ?? err);
  flushLogs().finally(() => process.exit(1));
});
