import { buildOeDiscordCommandDefinition } from "@open-everywhere/provider-discord/agent/commands/discord-commands.js";

async function main(): Promise<void> {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!applicationId || !botToken) {
    console.error("register-discord-commands: DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must both be set.");
    process.exitCode = 1;
    return;
  }

  const url = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

  const body = [buildOeDiscordCommandDefinition()];
  console.log(
    `Registering "/oe" ${guildId ? `on guild ${guildId} (instant)` : "GLOBALLY (may take up to ~1h to propagate)"} ` +
      `— PUT ${url.replace(applicationId, "<application-id>")} ...`,
  );

  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => undefined);
  if (!res.ok) {
    console.error(`register-discord-commands: Discord returned ${res.status}:`, json ?? "(no body)");
    process.exitCode = 1;
    return;
  }
  const count = Array.isArray(json) ? json.length : undefined;
  console.log(`Registered. ${count ?? "an unknown number of"} command(s) now active at this scope.`);
}

main().catch((err) => {
  console.error("register-discord-commands failed:", err);
  process.exitCode = 1;
});
