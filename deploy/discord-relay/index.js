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
  ],
  partials: [Partials.Channel, Partials.Message],
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
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (GUILD_ALLOWLIST.length && message.guildId && !GUILD_ALLOWLIST.includes(message.guildId)) return;

  if (!INGEST_URL) {
    const where = message.guildId ? `guild ${message.guildId}#${message.channelId}` : `DM ${message.channelId}`;
    const content = message.content?.length ? message.content : "(empty — is Message Content Intent enabled?)";
    console.log(`[oe-discord-relay] ${where} @${message.author.username}: ${content}`);
    return;
  }
  await forward(toPayload(message));
});

client.on(Events.Error, (err) => console.error("[oe-discord-relay] client error:", err?.message ?? err));
client.on(Events.ShardDisconnect, (_e, id) => console.warn(`[oe-discord-relay] shard ${id} disconnected — discord.js will reconnect`));
client.on(Events.ShardResume, (id) => console.log(`[oe-discord-relay] shard ${id} resumed`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[oe-discord-relay] ${sig} — closing gateway`);
    client.destroy().finally(() => process.exit(0));
  });
}

client.login(TOKEN).catch((err) => {
  console.error("[oe-discord-relay] login failed:", err?.message ?? err);
  process.exit(1);
});
