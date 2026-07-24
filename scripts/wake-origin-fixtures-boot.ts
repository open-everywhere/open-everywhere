import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";

registerNotionProvider();
registerGithubProvider();
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";

registerNotionProvider();
registerTeamsProvider();

await import("../packages/core/scripts/wake-origin-fixtures-test.js");
