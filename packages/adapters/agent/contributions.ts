export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/adapters",
  contributions: [
    { kind: "tool", name: "extend_workspace_time", module: "agent/sandbox/extend-workspace-time.js", summary: "Extend your workspace VM's lifetime by N minutes." },

    { kind: "hook", name: "sandbox-lifecycle", module: "agent/sandbox/vercel-lifecycle.js", summary: "Stop-after-turn sandbox lifecycle — stop the session's sandbox compute the moment a turn finishes instead of letting it idle out its timeout window. Backend-aware: Vercel and docker each own a stop, just-bash has none and says so." },
  ],
} as const;
