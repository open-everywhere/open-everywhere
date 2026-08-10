export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/adapters",
  contributions: [
    { kind: "tool", name: "extend_workspace_time", module: "agent/sandbox/extend-workspace-time.js", summary: "Extend your workspace VM's lifetime by N minutes." },

    { kind: "hook", name: "sandbox-lifecycle", module: "agent/sandbox/vercel-lifecycle.js", summary: "Stop-after-turn sandbox lifecycle — terminate the Vercel sandbox the moment a turn finishes instead of letting it idle out its timeout window." },
  ],
} as const;
