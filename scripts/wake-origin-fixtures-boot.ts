import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";

registerNotionProvider();

await import("../packages/core/scripts/wake-origin-fixtures-test.js");
