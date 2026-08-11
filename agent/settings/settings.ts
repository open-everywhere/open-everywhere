import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({
  delegation: { nativeSubagent: true },
});
