import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";

registerNotionProvider();
registerGithubProvider();

await import("../packages/core/scripts/wake-origin-fixtures-test.js");
