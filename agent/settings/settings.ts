import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({

  window: { topology: true },

  connectors: { dmOnly: false, userPrincipal: true, opTiering: true },

  browser: { enabled: true },

  identity: { name: "Open Everywhere", shortName: "oe" },

  wake: {
    e2eDrivers: [
      { surface: "slack", principal: "T0EXAMPLE:B0EXBOT0001" },
      { surface: "slack", principal: "T0EXAMPLE:B0EXBOT0002" },
      { surface: "discord", principal: "1300000000000000103" },
      { surface: "notion", principal: "40000000-0000-4000-8000-000000000106" },
    ],
  },
});
