import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({
  browser: { enabled: true },
  sandbox: { selfHostBackend: "justbash" },
  models: {
    targets: {
      gateway: { kind: "vercel-ai-gateway" },
      mistral: { kind: "vercel-ai-gateway", providers: { only: ["mistral"] }, dataPolicy: { zeroRetention: true } },
    },
  },
});
