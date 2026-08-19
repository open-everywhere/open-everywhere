import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({

  approvals: { judgeMode: "enforce" },

  window: { topology: true },

  connectors: { dmOnly: false, userPrincipal: true, opTiering: true },

  browser: { enabled: true, domains: "localhost,127.0.0.1,example.com,my-agent.vercel.app" },

  tools: { sourceScopedMount: true, genericReadVerbs: true },

  rotation: { quietGapHours: 12 },

  identity: { name: "Open Everywhere" },
});
