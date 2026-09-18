import { defineRoster } from "@open-everywhere/core/agent/scaffold/roster-config.js";

export default defineRoster({
  framework: {
    disable: {
      bash:
        "the eve built-in is DISABLED as a static tool. It is re-provided per session GRAIN " +
        "(stall-guarded) by tools/sandbox_tools.ts: task/native sessions mount it, standing seats " +
        "don't (window-tool-gating Stage C). The sentinel is what makes the per-grain provision " +
        "authoritative — a dynamic tool can only SHADOW a static built-in when it resolves, never " +
        "REMOVE it.",
      read_file:
        "the eve built-in is DISABLED as a static tool. It is re-provided per session GRAIN " +
        "(stall-guarded) by tools/sandbox_tools.ts: task/native sessions mount it, standing seats " +
        "don't (window-tool-gating Stage C). The sentinel is what makes the per-grain provision " +
        "authoritative — a dynamic tool can only SHADOW a static built-in when it resolves, never " +
        "REMOVE it.",
      web_fetch:
        "the eve built-in is DISABLED as a static tool. It is re-provided per session GRAIN " +
        "(stall-guarded) by tools/sandbox_tools.ts: task/native sessions mount it, standing seats " +
        "don't (window-tool-gating Stage C). The sentinel is what makes the per-grain provision " +
        "authoritative — a dynamic tool can only SHADOW a static built-in when it resolves, never " +
        "REMOVE it.",
      write_file:
        "the eve built-in is DISABLED as a static tool. It is re-provided per session GRAIN " +
        "(stall-guarded) by tools/sandbox_tools.ts: task/native sessions mount it, standing seats " +
        "don't (window-tool-gating Stage C). The sentinel is what makes the per-grain provision " +
        "authoritative — a dynamic tool can only SHADOW a static built-in when it resolves, never " +
        "REMOVE it.",
    },
  },

  core: {
    note: {
      "connection/notion":
        "Re-mount of the host-side Notion MCP connection (core owns the definition; see " +
        "@open-everywhere/core/agent/connections/notion.ts for the full auth/approval/enforcement " +
        "story). Deleted 2026-07-03 (commit e69af27) because Eve advertises every " +
        "agent/connections/*.ts file to EVERY session with no per-surface visibility filter — an " +
        "unmounted-but-ungranted connection is invisible; a mounted-but-ungranted one just leaks " +
        "the integration's existence in \"what tools do you have?\" (the hard gate still refuses " +
        "USE — no teeth were ever at risk, this is purely a UX/inventory-hygiene rule enforced by " +
        "scripts/connections-lint.ts: \"mount only when a bundle grants it\"). Restored 2026-07-05 " +
        "(backlog item 19, \"link real connectors\") because agent/access/bundles.ts now grants " +
        "\"notion\" for real (a `connectors: [{ name: \"notion\", credential: \"workspace-oauth\", " +
        "contentOrigin: \"external\" }]` grant — it named `team-key` until OPE-1914 re-credentialled " +
        "it to the org-subject MCP credential) — so the mount/grant pair is back in sync and " +
        "connections-lint passes.",
    },
  },

  adapters: {
    note: {
      "hook/sandbox-lifecycle":
        "Stop-after-turn sandbox lifecycle (Vercel): terminate the session VM the moment a turn " +
        "finishes — auto-snapshot preserves the tree, the next turn auto-resumes in ~0.5–3s, and " +
        "idle Provisioned-Memory billing (~99% of the sandbox bill) disappears. Vendor impl lives " +
        "in @open-everywhere/adapters. `sandbox.stopAfterTurn: false` disables it.",
      "tool/extend_workspace_time":
        "Extend the sandbox session's fixed time window before long-running work (a command still " +
        "running when the window expires is killed). Live-verified: extendTimeout() mid-session " +
        "lets an in-flight command outlive its original fuse. Vendor impl in " +
        "@open-everywhere/adapters; capped by `sandbox.extendMaxMinutes` (default 120), audited.",
    },
  },

  providers: {
    discord: {
      about:
        "discord (the deepest-integrated) — identity mapper, capability manifest, post arm, " +
        "wake-origin codec, read adapter, reaction surface, surface message ops " +
        "(post/edit/upload), approval-card poster, routine dispatch channel, native guild-admin " +
        "check, and scope-label resolver.",
    },
    github: {
      about:
        "github — the CHAT SURFACE only: identity mapper, capability manifest, post arm, " +
        "wake-origin codec. The SCM subsystem (PR/checkout/issue verbs, App-token minting, " +
        "config-repo PR, the \"github\" memory backing) STAYS in core and is registered by " +
        "register-adapters.ts directly.",
    },
    linear: {
      about:
        "linear — identity mapper, capability manifest, post arm, wake-origin codec, the " +
        "entity-action adapter (setState/assign/addLabel on an issue), and the telemetry " +
        "configured-surface probe.",
    },
    notion: {
      about:
        "notion (stage 3, the first extraction) — identity mapper, capability manifest, post arm, " +
        "wake-origin codec, and the \"notion\" MEMORY backing (a read-only silo with " +
        "provider:\"notion\", container:\"<root-page-id>\" resolves that page + all child pages " +
        "recursively; the integration token resolves lazily through the credential broker, " +
        "default ref NOTION_TOKEN).",
    },
    slack: {
      about:
        "slack (the reference surface) — identity mapper, capability manifest, post arm, " +
        "wake-origin codec, read adapter, reaction surface, the trusted-attachment resolver, the " +
        "OPE-110 governance member supplier (core keeps the seam + the fail-closed default), the " +
        "slack BRIDGE core's generic spine consumes (approval/connector cards, credential intake, " +
        "dispatch channel, display names, the internal-channel gate), and the ops arms " +
        "(quickstart step + telemetry probe).",
    },
    teams: {
      about:
        "teams — identity mapper, capability manifest, post arm, wake-origin codec, the Microsoft " +
        "Graph read adapter, and the proactive routine dispatcher (a Teams routine fire needs the " +
        "Bot Framework conversation reference the inbound turn captured).",
    },
  },
});
