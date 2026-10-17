import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({

  browser: { enabled: true },

  identity: { name: "Open Everywhere", shortName: "oe" },

  wake: {
    e2eDrivers: [
      { surface: "slack", principal: "T0EXAMPLE:B0EXBOT0001" },
      { surface: "slack", principal: "T0EXAMPLE:B0EXBOT0002" },
      { surface: "discord", principal: "1300000000000000103" },
      { surface: "notion", principal: "40000000-0000-4000-8000-000000000106" },
    ],
    driverAllowlist: ["T0EXAMPLE:B0EXBOT0001", "T0EXAMPLE:B0EXBOT0002", "1300000000000000100:1300000000000000103"],
    testWakeRoute: true,
  },

  sandbox: { selfHostBackend: "justbash" },

  models: {
    targets: {
      gateway: { kind: "vercel-ai-gateway" },
      mistral: { kind: "vercel-ai-gateway", providers: { only: ["mistral"] }, dataPolicy: { zeroRetention: true } },
    },
  },
});
