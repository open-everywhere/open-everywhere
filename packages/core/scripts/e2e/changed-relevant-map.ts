import { pathMatchesGlob } from "../../agent/review/facts-artifact.js";

export interface ChangedRelevantArea {
  readonly area: string;
  readonly globs: readonly string[];
  readonly scenarios: readonly string[];
  readonly why: string;
}

export const CHANGED_RELEVANT_MAP: readonly ChangedRelevantArea[] = [
  {
    area: "slack-provider",
    globs: ["packages/providers/slack/**"],
    scenarios: [
      "J1", "J2", "S-MEM-READ", "J3", "S6", "S8", "S9", "S10", "S11", "S13", "S14", "S-LINK-SLACK",
      "J4", "S20", "S23", "S24", "F-ART", "F-EDIT", "F-SEC", "J-SUP", "J-UNIFIED", "J-UNI-X", "J-PR",
      "S-PR-SESSION", "S-PR-BOUNDARY", "S-AWS-BOUNDARY", "J-WORKFLOW", "S-NOTION-WRITE",
      "S-CONNECTOR-TIER", "S-DM-NOTION", "S-CONNECT-CARD", "S-APIKEY-INTAKE", "S-TAINT-DRYRUN",
      "S-TAINT-ROUTE-LIVE", "S-TAINT-UNATTENDED-DENY",
    ],
    why: "Slack is the default e2e surface — every scenario without its own dedicated surface drives through it (`surface: \"slack\"` or `\"cross\"` in scenarios.ts), so a Slack provider change is broadly relevant by construction, not an over-selection.",
  },
  {
    area: "discord-provider",
    globs: ["packages/providers/discord/**"],
    scenarios: ["J-DISC", "S8"],
    why: "J-DISC is surface: \"discord\"; S8 is the Slack→Discord cross-surface recall leg (surface: \"cross\"). (S-DM-DISCORD retired at OPE-725 — see scenarios.ts.)",
  },
  {
    area: "teams-provider",
    globs: ["packages/providers/teams/**"],
    scenarios: ["J-TEAMS", "J-TEAMS-DM"],
    why: "J-TEAMS and J-TEAMS-DM are the two surface: \"teams\" scenarios (channel and 1:1 DM respectively); J-TEAMS is also the smoke-lane's non-Slack half (scenarios.ts smoke: true) — J-TEAMS-DM is not (it self-skips until the driver's Chat.* Graph scope is consented, OPE-972).",
  },
  {
    area: "github-provider",
    globs: ["packages/providers/github/**"],
    scenarios: ["J-GH", "J-PR", "S-PR-SESSION", "S-PR-BOUNDARY", "J-WORKFLOW", "J-UNI-X"],
    why: "J-GH is surface: \"github\"; the rest open, read status on, or subscribe to a real GitHub PR (open_pull_request's chain) and would break silently on a GitHub adapter regression even though they run through Slack.",
  },
  {
    area: "linear-provider",
    globs: ["packages/providers/linear/**"],
    scenarios: ["J-LIN"],
    why: "J-LIN is the only surface: \"linear\" scenario.",
  },
  {
    area: "notion-provider",
    globs: ["packages/providers/notion/**"],
    scenarios: ["J-NOT", "S24", "S-NOTION-WRITE", "S-CONNECTOR-TIER", "S-DM-NOTION", "S-CONNECT-CARD", "S-APIKEY-INTAKE"],
    why: "J-NOT is surface: \"notion\"; the rest all drive a live Notion connector (read at S24/S-DM-NOTION, write at S-NOTION-WRITE/S-CONNECTOR-TIER, offer/intake at S-CONNECT-CARD/S-APIKEY-INTAKE).",
  },

  {
    area: "approvals",
    globs: ["packages/core/agent/approvals/**", "packages/core/agent/access/approver-chain.ts", "packages/core/agent/access/approval-*.ts", "packages/core/agent/access/pre-approval-rules.ts"],
    scenarios: ["J3", "J4", "S-PR-BOUNDARY", "S-AWS-BOUNDARY", "S-CONNECTOR-TIER", "S-NOTION-WRITE", "J-PR", "S-PR-SESSION", "F-SEC"],
    why: "These gate on an `approval.chain` row (verdict, transform, card-vs-judge path) — the doctrine's P1.1 list of what the approval seam must prove.",
  },
  {
    area: "taint",
    globs: [
      "packages/core/agent/access/taint-*.ts",
      "packages/core/agent/access/untrusted*.ts",
      "packages/core/agent/access/ingestion-*.ts",
      "packages/core/agent/channels/channel-read.ts",
      "packages/core/agent/access/skill-taint-envelope.ts",
      "packages/core/agent/access/subagent-taint.ts",
      "packages/core/agent/approvals/taint-disclosure.ts",
      "packages/core/agent/hooks/spawn-taint.ts",
      "agent/access/bundles.ts",
    ],
    scenarios: ["S-TAINT-DRYRUN", "S-TAINT-ROUTE-LIVE", "S-TAINT-UNATTENDED-DENY", "F-SEC"],
    why: "The three S-TAINT-* legs and F-SEC's tainted-content probe are the only scenarios that gate on `taint.verdict`/tainted+taintKinds audit rows rather than reply text (doctrine P1.3), and S-TAINT-ROUTE-LIVE's ARM E is the only one that reads the repo-root approver lowering the `taint:ask` floor refuses.",
  },
  {
    area: "identity",
    globs: ["packages/core/agent/identity/**"],
    scenarios: ["S-LINK-SLACK"],
    why: "S-LINK-SLACK is the only scenario asserting on `identity.link.*` audit rows (doctrine P1.4's worked example lives one layer below, in the derivation unit tests, not the live pack).",
  },
  {
    area: "memory",
    globs: ["packages/core/agent/memory/**"],
    scenarios: ["S-MEM-READ", "J2", "S-DM-NOTION"],
    why: "S-MEM-READ and J2 exercise recall/silo isolation/purge directly; S-DM-NOTION's DM seat carries personal memory as part of its journey.",
  },
  {
    area: "routines",
    globs: ["packages/core/agent/routines/**", "packages/core/agent/tools/*_routine*.ts", "packages/core/agent/tools/*routine*.ts"],
    scenarios: ["S23", "S-TAINT-UNATTENDED-DENY"],
    why: "S23 proves create_routine(\"once\") acks; S-TAINT-UNATTENDED-DENY proves a real dispatcher-fired routine's gated action is refused before the approval plane (doctrine P2.6).",
  },
  {
    area: "webhooks",
    globs: [
      "packages/core/agent/webhooks/**",
      "packages/core/agent/tools/declare_webhook.ts",
      "packages/core/agent/tools/rotate_webhook.ts",
      "packages/core/agent/tools/read_webhook_history.ts",
      "packages/core/agent/tools/list_webhooks.ts",
    ],
    scenarios: ["S20", "J-GH", "J-LIN", "J-NOT"],
    why: "S20 is the direct signed-POST ingress proof; J-GH/J-LIN/J-NOT each include a forge-replay ambient wake off the same webhook plane.",
  },
  {
    area: "spend",
    globs: ["packages/core/agent/spend/**"],
    scenarios: ["S10"],
    why: "S10 is the only scenario proving the spend-cap circuit breaker and which ingress door it refused at.",
  },
  {
    area: "credentials-and-connectors",
    globs: ["packages/core/agent/credentials/**", "packages/core/agent/connections/**"],
    scenarios: ["S-NOTION-WRITE", "S-CONNECTOR-TIER", "S-CONNECT-CARD", "S-APIKEY-INTAKE", "S-AWS-BOUNDARY"],
    why: "These are the connector-WRITE and credential-intake legs (doctrine P3.9) — a credential broker or connector-auth regression breaks them without necessarily breaking a read-only Notion scenario.",
  },
  {
    area: "aws-tool",
    globs: ["packages/core/agent/tools/aws.ts", "packages/core/agent/connections/aws-*.ts"],
    scenarios: ["S-AWS-BOUNDARY"],
    why: "S-AWS-BOUNDARY is the only scenario on the ungated `aws` tool's one control — the fail-closed awsRoles grant.",
  },
  {
    area: "artifacts-and-attachments",
    globs: ["packages/core/agent/tools/post_file.ts", "packages/core/agent/tools/describe_image.ts", "packages/core/agent/tools/read_file_upload.ts"],
    scenarios: ["F-ART"],
    why: "F-ART is the only scenario driving post_file + describe_image + the attachment trusted-fetch path together.",
  },
  {
    area: "wake-envelope",
    globs: ["packages/core/agent/channels/wake-envelope.ts", "packages/core/agent/channels/normalized-wake.ts"],
    scenarios: ["F-EDIT", "J1"],
    why: "F-EDIT is the live primary-model probe for the edit-aware wake envelope; J1 is the plain wake+continuity baseline the envelope also carries.",
  },
  {
    area: "delegation-and-subagents",
    globs: ["packages/core/agent/tools/spawn_task.ts", "packages/core/agent/tools/spawn_thread_session.ts", "packages/core/agent/tools/delegation_tools.ts", "packages/core/agent/subagents/**"],
    scenarios: ["J-SUP", "S-DM-NOTION", "S-MEM-READ", "J-UNI-X"],
    why: "Each of these pays a delegation round-trip as part of its own proof (S-MEM-READ/S-DM-NOTION need the control-read creds reached only via delegation; J-SUP/J-UNI-X route through a spawned worker). (S-DM-DISCORD retired at OPE-725 — see scenarios.ts.)",
  },
  {
    area: "delegation-identity",
    globs: [
      "packages/core/agent/channels/task-wake.ts",
      "packages/core/agent/access/dispatch-origin-signal.ts",
      "packages/core/agent/hooks/settlement-flush.ts",
    ],
    scenarios: ["S-TAINT-ROUTE-LIVE", "J-SUP", "S-DM-NOTION", "S-MEM-READ", "J-UNI-X"],
    why: "All three files fire on every real spawn_task dispatch and settlement, through the same hooks/spawn-taint.ts wiring that calls openTaskWake/installTaskWake (task-wake.ts), addressedWakeThisTurn/noteTaskDispatchedThisTurn (dispatch-origin-signal.ts), and flushDirtyTreeAtTurnEnd/flushSettledMemory/noteTaskDispatched/noteTaskSettled/noteTaskViews (settlement-flush.ts). S-TAINT-ROUTE-LIVE's single-delegated-task arm already drives a real delegated worker through that exact wiring (see its ARM A/D shape in scenarios.ts); J-SUP/S-DM-NOTION/S-MEM-READ/J-UNI-X pay the same delegation round-trip (the delegation-and-subagents area above). A regression in any of these three files breaks the delegated round-trip all five scenarios already require to pass.",
  },
  {
    area: "connector-op-gating",
    globs: ["packages/core/agent/access/connector-op-gating.ts", "packages/core/agent/access/connector-scope.ts", "packages/core/agent/access/connector-disclosure.ts"],
    scenarios: ["S-CONNECTOR-TIER", "S-NOTION-WRITE"],
    why: "S-CONNECTOR-TIER is the direct live proof that classifyConnectorOp's read/write split gates at runtime; S-NOTION-WRITE is the write leg it splits against.",
  },
  {
    area: "pr-write-tool",
    globs: ["packages/core/agent/tools/open_pull_request.ts", "packages/core/agent/approvals/pr-open.ts"],
    scenarios: ["J-PR", "S-PR-SESSION", "S-PR-BOUNDARY", "J-WORKFLOW", "J-UNI-X"],
    why: "These are every scenario that calls open_pull_request — the one consequential-write door with its own approval shape (card vs. armed-judge vs. session-grant vs. ungranted-repo refusal).",
  },
  {
    area: "core-agent-loop",
    globs: ["agent/agent.ts", "packages/core/agent/control/**"],
    scenarios: ["J1", "J2", "J3", "J4", "J-DISC", "J-GH", "J-LIN", "J-NOT"],
    why: "The core turn loop and eve-facing agent definition underlie every journey scenario; the J-prefixed set is the cheapest per-surface baseline that would catch a loop-level regression without re-running the whole roster.",
  },
];

export const ALWAYS_RELEVANT: readonly string[] = ["J1", "J-TEAMS"];

export const UNMAPPED_BY_DESIGN: readonly { id: string; why: string }[] = [];

export function relevantScenarios(changedPaths: readonly string[]): string[] {
  const ids = new Set<string>(ALWAYS_RELEVANT);
  for (const path of changedPaths) {
    for (const area of CHANGED_RELEVANT_MAP) {
      if (area.globs.some((g) => pathMatchesGlob(path, g))) {
        for (const id of area.scenarios) ids.add(id);
      }
    }
  }
  return [...ids];
}
