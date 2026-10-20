import type { Capability } from "./env.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

export type LaneResource =
  | "seat:e2e-unified"
  | "seat:e2e-b"
  | "seat:e2e-cap"
  | "seat:e2e-connector"
  | "seat:slack-private"
  | "seat:slack-mpim"
  | "seat:slack-halt"
  | "seat:slack-supervisor"
  | "seat:dm"
  | "seat:email"
  | "seat:engaged-slack"
  | "seat:engaged-discord"
  | "seat:engaged-teams"
  | "seat:engaged-github"
  | "seat:engaged-linear"
  | "seat:engaged-notion"
  | "fixture:pr-repo"
  | "fixture:webhook";

export const LANE_RESOURCE_NAMES: Readonly<Record<LaneResource, string>> = {
  "seat:e2e-unified": "unified domain seat",
  "seat:e2e-b": "channel B room",
  "seat:e2e-cap": "spend-cap room",
  "seat:e2e-connector": "connector room",
  "seat:slack-private": "private Slack room",
  "seat:slack-mpim": "group DM",
  "seat:slack-halt": "halt room",
  "seat:slack-supervisor": "supervisor room",
  "seat:dm": "driver DM seat",
  "seat:email": "email inboxes",
  "seat:engaged-slack": "addressed-only Slack room",
  "seat:engaged-discord": "addressed-only Discord room",
  "seat:engaged-teams": "addressed-only Teams room",
  "seat:engaged-github": "addressed-only GitHub repo",
  "seat:engaged-linear": "addressed-only Linear team",
  "seat:engaged-notion": "addressed-only Notion page",
  "fixture:pr-repo": "pull-request fixture repo",
  "fixture:webhook": "webhook fixture",
};

export type LaneDeclaration =
  | { readonly id: string; readonly parallel: "safe"; readonly resources: readonly LaneResource[] }
  | { readonly id: string; readonly parallel: "serial"; readonly why: string };

export const CAPABILITY_RESOURCES: Readonly<Partial<Record<Capability, LaneResource>>> = {
  slackUnified: "seat:e2e-unified",
  slackChannelB: "seat:e2e-b",
  slackCapFixture: "seat:e2e-cap",
  connectorWrite: "seat:e2e-connector",
  notion: "seat:e2e-connector",
  slackPrivate: "seat:slack-private",
  slackMpim: "seat:slack-mpim",
  slackHalt: "seat:slack-halt",
  slackSupervisor: "seat:slack-supervisor",
  syntheticDm: "seat:dm",
  email: "seat:email",
  engagedSlack: "seat:engaged-slack",
  engagedDiscord: "seat:engaged-discord",
  engagedTeams: "seat:engaged-teams",
  engagedGithub: "seat:engaged-github",
  engagedLinear: "seat:engaged-linear",
  engagedNotion: "seat:engaged-notion",
  pr: "fixture:pr-repo",
  webhook: "fixture:webhook",
};

export const LANE_DECLARATIONS: readonly LaneDeclaration[] = [
  { id: "J1", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J2", parallel: "safe", resources: ["seat:e2e-unified", "seat:e2e-b"] },
  { id: "S-MEM-READ", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J3", parallel: "serial", why: "raises and clears a spend cap on the base room through the control plane" },
  { id: "S6", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-OE-STATUS", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-DISC", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S8", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S9", parallel: "safe", resources: ["seat:slack-private"] },
  { id: "S10", parallel: "safe", resources: ["seat:e2e-unified", "seat:e2e-cap"] },
  { id: "S-SPEND-DM-MASK", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-SPEND-REFUSAL-KEYS", parallel: "serial", why: "writes spend settings through the control plane" },
  { id: "S11", parallel: "safe", resources: ["seat:e2e-unified", "seat:slack-private"] },
  { id: "S13", parallel: "safe", resources: ["seat:dm"] },
  { id: "S-VOICE-CLIP", parallel: "safe", resources: ["seat:dm"] },
  { id: "S-DATA-POLICY", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-MODEL-TARGET", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S14", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-LINK-SLACK", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "J4", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm", "seat:e2e-connector"] },
  { id: "J-MPIM", parallel: "safe", resources: ["seat:slack-mpim"] },
  { id: "S20", parallel: "safe", resources: ["seat:e2e-unified", "fixture:webhook"] },
  { id: "S23", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S24", parallel: "safe", resources: ["seat:e2e-connector"] },
  { id: "J-TEAMS", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-ENGAGED-teams", parallel: "safe", resources: ["seat:engaged-teams"] },
  { id: "J-TEAMS-DM", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-GH", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-LIN", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-NOT", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-OWN-ACCOUNT-NOTION", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "F-ART", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "F-QA-REPO", parallel: "safe", resources: ["seat:e2e-unified", "fixture:pr-repo"] },
  { id: "S-GH-TOKEN", parallel: "safe", resources: ["seat:e2e-unified", "fixture:pr-repo"] },
  { id: "F-EDIT", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "F-SEC", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-SUP", parallel: "safe", resources: ["seat:slack-supervisor"] },
  { id: "S-DELEGATED-slack", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-DELEGATED-discord", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-DELEGATED-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-DELEGATED-linear", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-DELEGATED-github", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-DELEGATED-notion", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-GITHUB-NOTION-REST", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SUSPENDED-slack", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-SUSPENDED-discord", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SUSPENDED-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-CARD-SUMMARY", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-BLOCKED-PING", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-CARD-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-NAMEDROP-teams", parallel: "safe", resources: ["seat:engaged-teams"] },
  { id: "S-OE-CMD-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-INTRO-teams", parallel: "safe", resources: ["seat:engaged-teams"] },
  { id: "S-CARD-teams-dm", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SUSPENDED-linear", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SUSPENDED-github", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-AMBIENT-discord", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-AMBIENT-linear", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-AMBIENT-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SIBLING-discord", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SIBLING-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SIBLING-notion", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-LINK-discord", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-LINK-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-APP-HOME", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-SIDE-PANEL", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-SESSION-STOP", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-DM-MCP-PROPOSE", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-JOB-WAIT", parallel: "safe", resources: ["seat:dm"] },
  { id: "S-REPLY-FEEDBACK", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "J-REACT-slack", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-REPLY-FOLLOWUPS", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-MEMORY-CANVAS", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-CANVAS-LIST", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-LIST-WRITE", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-WATCH", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-ROOM-SUGGEST", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-DOING", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-ROUTINE-TEST", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-ROUTINE-TEST-discord", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-ASK-WATCH", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-EXIT-KIT", parallel: "serial", why: "exports the org, erases a person and sets the org retention setting through the control plane" },
  { id: "S-COVER", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-COVER-teams", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-HALT", parallel: "serial", why: "pulls and clears the break-glass halt through the control plane" },
  { id: "J-UNIFIED", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-UNI-X", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-PR", parallel: "safe", resources: ["seat:e2e-unified", "fixture:pr-repo"] },
  { id: "S-PR-SESSION", parallel: "safe", resources: ["seat:e2e-unified", "fixture:pr-repo"] },
  { id: "S-PR-BOUNDARY", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-AWS-BOUNDARY", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "J-WORKFLOW", parallel: "safe", resources: ["seat:e2e-unified", "fixture:pr-repo"] },
  { id: "S-NOTION-WRITE", parallel: "safe", resources: ["seat:e2e-connector"] },
  { id: "S-A2A-DELEGATE", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-A2A-INBOUND", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-CONNECTOR-TIER", parallel: "safe", resources: ["seat:e2e-connector"] },
  { id: "S-DM-NOTION", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-PROVENANCE-DM", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-EVE-CARD", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-CONNECT-CARD", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-APIKEY-INTAKE", parallel: "safe", resources: ["seat:e2e-unified", "seat:e2e-connector"] },
  { id: "S-TAINT-DRYRUN", parallel: "safe", resources: ["seat:e2e-unified", "fixture:pr-repo"] },
  { id: "S-TAINT-ROUTE-LIVE", parallel: "safe", resources: ["seat:e2e-unified", "seat:e2e-connector", "fixture:pr-repo"] },
  { id: "S-JUDGE-LIFT-NOTICE", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-TAINT-UNATTENDED-DENY", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-ROUTINE-CONNECTOR-WRITE", parallel: "safe", resources: ["seat:e2e-unified", "seat:e2e-connector"] },
  { id: "S-DISCORD-GRANT", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-DM-STOP-GRANT", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "J-ENGAGED-slack", parallel: "safe", resources: ["seat:e2e-unified", "seat:engaged-slack"] },
  { id: "J-ENGAGED-discord", parallel: "safe", resources: ["seat:engaged-discord"] },
  { id: "J-ENGAGED-github", parallel: "safe", resources: ["seat:engaged-github"] },
  { id: "J-ENGAGED-linear", parallel: "safe", resources: ["seat:engaged-linear"] },
  { id: "J-ENGAGED-notion", parallel: "safe", resources: ["seat:engaged-notion"] },
  { id: "S-SLACK-AS-YOU", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-STEP-LABELS", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-MEETING-RECAP", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-MEETING-DISCORD-VOICE", parallel: "safe", resources: ["seat:e2e-unified"] },
  { id: "S-EMAIL-ROOM-REPLY", parallel: "safe", resources: ["seat:email"] },
  { id: "S-EMAIL-DM-FORWARD", parallel: "safe", resources: ["seat:email"] },
  { id: "S-EMAIL-STRANGER-REFUSED", parallel: "safe", resources: ["seat:email"] },
  { id: "S-PERSONAL-BROWSER", parallel: "safe", resources: ["seat:e2e-unified", "seat:dm"] },
  { id: "S-MEETING-NATIVE-RECAP", parallel: "safe", resources: ["seat:e2e-unified"] },
];

export interface LaneDeclarationProblems {
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
  readonly duplicate: readonly string[];
  readonly empty: readonly string[];
  readonly underDeclared: readonly string[];
}

export function laneDeclarationProblems(
  scenarios: readonly Pick<Scenario, "id" | "requires">[] = SCENARIOS,
  rows: readonly LaneDeclaration[] = LANE_DECLARATIONS,
): LaneDeclarationProblems {
  const seen = new Set<string>();
  const duplicate: string[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) duplicate.push(row.id);
    seen.add(row.id);
  }
  const roster = new Map(scenarios.map((s) => [s.id, s]));
  const underDeclared: string[] = [];
  for (const row of rows) {
    const scenario = roster.get(row.id);
    if (!scenario || row.parallel !== "safe") continue;
    for (const cap of scenario.requires) {
      const implied = CAPABILITY_RESOURCES[cap];
      if (implied && !row.resources.includes(implied)) underDeclared.push(`${row.id}:${implied}`);
    }
  }
  return {
    missing: scenarios.filter((s) => !seen.has(s.id)).map((s) => s.id),
    unknown: rows.filter((r) => !roster.has(r.id)).map((r) => r.id),
    duplicate,
    empty: rows.filter((r) => (r.parallel === "safe" ? r.resources.length === 0 : r.why.trim().length === 0)).map((r) => r.id),
    underDeclared,
  };
}

export function renderLaneDeclarationProblems(problems: LaneDeclarationProblems): string[] {
  const out: string[] = [];
  if (problems.missing.length > 0) out.push(`legs with no lane declaration: ${problems.missing.join(", ")}`);
  if (problems.unknown.length > 0) out.push(`declarations for legs the roster does not hold: ${problems.unknown.join(", ")}`);
  if (problems.duplicate.length > 0) out.push(`legs declared twice: ${problems.duplicate.join(", ")}`);
  if (problems.empty.length > 0) out.push(`declarations with no resource or no reason: ${problems.empty.join(", ")}`);
  if (problems.underDeclared.length > 0) out.push(`declarations that omit a required room's resource: ${problems.underDeclared.join(", ")}`);
  return out;
}

export function laneDeclarationIndex(rows: readonly LaneDeclaration[] = LANE_DECLARATIONS): ReadonlyMap<string, LaneDeclaration> {
  return new Map(rows.map((r) => [r.id, r]));
}
