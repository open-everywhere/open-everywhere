import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";

registerNotionProvider();
registerGithubProvider();
registerTeamsProvider();
registerLinearProvider();
registerDiscordProvider();

await import("../packages/core/scripts/wake-origin-fixtures-test.js");
