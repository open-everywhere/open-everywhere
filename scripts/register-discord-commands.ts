import { buildOeDiscordCommandDefinition } from "@open-everywhere/provider-discord/agent/commands/discord-commands.js";
import { oeSlash } from "@open-everywhere/core/agent/commands/core.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";
import { getSettings, registerSettings, type AgentSettingsOverrides } from "@open-everywhere/core/agent/settings/settings.js";

async function main(): Promise<void> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  try {
    const { SETTINGS_OVERRIDES } = await importAppModule<{ SETTINGS_OVERRIDES: AgentSettingsOverrides }>("agent/settings/settings.ts", resolveAppRoot());
    registerSettings(SETTINGS_OVERRIDES);
  } catch (err) {
    console.error(`register-discord-commands: agent/settings/settings.ts did not load — refusing to register a default-named command: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const applicationId = getSettings().discord.applicationId;
  if (!applicationId || !botToken) {
    console.error("register-discord-commands: the discord.applicationId setting and DISCORD_BOT_TOKEN must both be set.");
    process.exitCode = 1;
    return;
  }
  const url = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;
  const body = [buildOeDiscordCommandDefinition()];
  console.log(
    `Registering "${oeSlash()}" ${guildId ? `on guild ${guildId} (instant)` : "GLOBALLY (may take up to ~1h to propagate)"} ` +
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
