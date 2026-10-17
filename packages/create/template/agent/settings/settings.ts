import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({
  browser: { enabled: true },
  sandbox: { selfHostBackend: "justbash" },
});
