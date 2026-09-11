import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({

  approvals: { judgeMode: "enforce" },

  window: { topology: true },

  connectors: { dmOnly: false, userPrincipal: true, opTiering: true },

  browser: { enabled: true },

  identity: { name: "Open Everywhere" },

  wake: { slackDmDriver: "T0EXAMPLE:B0EXBOT0001" },
});
