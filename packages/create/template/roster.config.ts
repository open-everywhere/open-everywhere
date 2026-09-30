import { defineRoster } from "@open-everywhere/core/agent/scaffold/roster-config.js";

export default defineRoster({
  framework: {
    disable: {
      bash: "re-provided per session grain by core (tools/sandbox_tools.ts)",
      read_file: "re-provided per session grain by core (tools/sandbox_tools.ts)",
      web_fetch: "re-provided per session grain by core (tools/sandbox_tools.ts)",
      write_file: "re-provided per session grain by core (tools/sandbox_tools.ts)",
    },
  },

  core: true,
  adapters: true,

  providers: {
    slack: true,
    notion: true,
    github: true,
  },
});
