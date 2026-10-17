import { SCENARIOS, type Scenario } from "./scenarios.js";

export const RELEASE_SCOPE_NAMES = ["launch"] as const;
export type ReleaseScopeName = (typeof RELEASE_SCOPE_NAMES)[number];
export type ReleaseRequirement = "REQUIRED" | "NON_LAUNCH";
export type ReleasePhase = "discord-grant-tapped";

export interface ReleaseScopeRow {
  readonly id: string;
  readonly requirement: ReleaseRequirement;
  readonly reason: string;
  readonly requiredPhase?: ReleasePhase;
  readonly equivalents?: readonly string[];
}

const REQUIRED_IDS = [
  "J1",
  "J2",
  "S-MEM-READ",
  "J3",
  "S6",
  "S-OE-STATUS",
  "S9",
  "S10",
  "S-SPEND-DM-MASK",
  "S-DISCORD-GRANT",
  "S-SPEND-REFUSAL-KEYS",
  "S11",
  "S13",
  "S-VOICE-CLIP",
  "S14",
  "S-LINK-SLACK",
  "J4",
  "J-MPIM",
  "S20",
  "S23",
  "S24",
  "J-GH",
  "J-NOT",
  "S-OWN-ACCOUNT-NOTION",
  "F-ART",
  "F-QA-REPO",
  "F-EDIT",
  "F-SEC",
  "J-SUP",
  "S-DELEGATED-slack",
  "S-DELEGATED-github",
  "S-DELEGATED-notion",
  "S-GITHUB-NOTION-REST",
  "S-SUSPENDED-slack",
  "S-CARD-SUMMARY",
  "S-SIBLING-notion",
  "S-HALT",
  "J-UNIFIED",
  "J-UNI-X",
  "J-PR",
  "S-PR-SESSION",
  "S-PR-BOUNDARY",
  "S-AWS-BOUNDARY",
  "J-WORKFLOW",
  "S-NOTION-WRITE",
  "S-CONNECTOR-TIER",
  "S-DM-NOTION",
  "S-PROVENANCE-DM",
  "S-EVE-CARD",
  "S-CONNECT-CARD",
  "S-APIKEY-INTAKE",
  "S-TAINT-DRYRUN",
  "S-TAINT-ROUTE-LIVE",
  "S-TAINT-UNATTENDED-DENY",
  "S-ROUTINE-CONNECTOR-WRITE",
  "S-DM-STOP-GRANT",
  "S-SIDE-PANEL",
  "J-ENGAGED-slack",
  "J-ENGAGED-github",
  "J-ENGAGED-notion",
] as const;

const NON_LAUNCH_ROWS: readonly ReleaseScopeRow[] = [
  {
    id: "S-SUSPENDED-github",
    requirement: "NON_LAUNCH",
    reason:
      "Known unsupported pilot capability: no connector write that raises an op.connector card is reachable from a GitHub seat, so the static GAP cannot produce live card/click/write/reply evidence. S-GITHUB-NOTION-REST remains REQUIRED but proves a standing shared REST write with no per-write approval and is not an equivalent. Reclassify this row when a GitHub-reachable carded connector write ships.",
  },
  { id: "J-DISC", requirement: "NON_LAUNCH", reason: "Discord-only confidence is deferred for this release." },
  {
    id: "S8",
    requirement: "NON_LAUNCH",
    reason:
      "Its Discord transport is outside this release; J2 proves memory-backed same-domain recall plus cross-domain silo isolation, and J-UNI-X proves launch-surface cross-surface recall.",
    equivalents: ["J2", "J-UNI-X"],
  },
  { id: "J-TEAMS", requirement: "NON_LAUNCH", reason: "Teams-only confidence is deferred for this release." },
  { id: "J-ENGAGED-teams", requirement: "NON_LAUNCH", reason: "Teams-only confidence is deferred for this release." },
  { id: "J-TEAMS-DM", requirement: "NON_LAUNCH", reason: "Teams-only confidence is deferred for this release." },
  { id: "J-LIN", requirement: "NON_LAUNCH", reason: "Linear-only confidence is deferred for this release." },
  { id: "S-DELEGATED-discord", requirement: "NON_LAUNCH", reason: "Discord-only transport parity is deferred for this release." },
  { id: "S-DELEGATED-teams", requirement: "NON_LAUNCH", reason: "Teams-only transport parity is deferred for this release." },
  { id: "S-DELEGATED-linear", requirement: "NON_LAUNCH", reason: "Linear-only transport parity is deferred for this release." },
  { id: "S-SUSPENDED-discord", requirement: "NON_LAUNCH", reason: "Discord-only approval transport parity is deferred for this release." },
  { id: "S-SUSPENDED-teams", requirement: "NON_LAUNCH", reason: "Teams-only approval transport parity is deferred for this release." },
  { id: "S-CARD-teams", requirement: "NON_LAUNCH", reason: "Teams-only approval transport parity is deferred for this release." },
  { id: "S-CARD-teams-dm", requirement: "NON_LAUNCH", reason: "Teams-only approval transport parity is deferred for this release." },
  { id: "J-NAMEDROP-teams", requirement: "NON_LAUNCH", reason: "Teams-only confidence is deferred for this release." },
  { id: "S-OE-CMD-teams", requirement: "NON_LAUNCH", reason: "Teams-only control-plane parity is deferred for this release." },
  { id: "S-INTRO-teams", requirement: "NON_LAUNCH", reason: "Teams-only onboarding parity is deferred for this release." },
  { id: "S-SUSPENDED-linear", requirement: "NON_LAUNCH", reason: "Linear-only approval transport parity is deferred for this release." },
  { id: "S-AMBIENT-discord", requirement: "NON_LAUNCH", reason: "Discord-only ambient behavior is deferred for this release." },
  { id: "S-AMBIENT-linear", requirement: "NON_LAUNCH", reason: "Linear-only ambient behavior is deferred for this release." },
  { id: "S-AMBIENT-teams", requirement: "NON_LAUNCH", reason: "Teams-only ambient behavior is deferred for this release." },
  { id: "S-SIBLING-discord", requirement: "NON_LAUNCH", reason: "Discord-only sibling routing is deferred for this release." },
  { id: "S-SIBLING-teams", requirement: "NON_LAUNCH", reason: "Teams-only sibling routing is deferred for this release." },
  { id: "S-LINK-discord", requirement: "NON_LAUNCH", reason: "Discord-only identity-link transport is deferred for this release." },
  { id: "S-LINK-teams", requirement: "NON_LAUNCH", reason: "Teams-only identity-link transport is deferred for this release." },
  { id: "J-ENGAGED-discord", requirement: "NON_LAUNCH", reason: "Discord-only engaged routing is deferred for this release." },
  { id: "J-ENGAGED-linear", requirement: "NON_LAUNCH", reason: "Linear-only engaged routing is deferred for this release." },
  { id: "S-JUDGE-LIFT-NOTICE", requirement: "NON_LAUNCH", reason: "The judge's decision to LIFT is a model judgement this tier cannot drive, so the leg's green is not a release signal — its hard gates are." },
  { id: "S-APP-HOME", requirement: "NON_LAUNCH", reason: "The Home tab needs the fixture Slack app reinstalled with `home_tab_enabled` and the `app_home_opened` event (OPE-2451); until the board's app carries them, views.publish refuses and the leg cannot go green." },
  { id: "S-MEMORY-CANVAS", requirement: "NON_LAUNCH", reason: "The take-down half needs a Slack Connect channel, or a channel with a guest member, in the e2e domain's reach, which no launch fixture carries; until one exists the leg ends as a missing fixture after its internal half." },
  { id: "S-COVER", requirement: "NON_LAUNCH", reason: "Out-of-office cover is opt-in per person and new in this release; no board has run the leg live yet, and its recap gate waits up to two cover-recap schedule ticks. `test:cover` and `test:slack-cover` prove the road offline." },
  { id: "S-DOING", requirement: "NON_LAUNCH", reason: "The open and the Pause are Home-tab deliveries, which need the fixture Slack app reinstalled with the Home tab on (OPE-2451), as S-APP-HOME and S-WATCH do. `test:doing-for-me` drives the list, its actions and the DM read offline." },
  { id: "S-WATCH", requirement: "NON_LAUNCH", reason: "The None click and the forged Not useful are Home-tab deliveries, which need the fixture Slack app reinstalled with the Home tab on (OPE-2451); the watch's own check needs a calendar connector no launch fixture carries, so `test:personal-watch` drives it offline." },
  { id: "S-SLACK-AS-YOU", requirement: "NON_LAUNCH", reason: "Search Slack as you is an admin opt-in that needs the Slack app's MCP toggle and the person's own sign-in, which no launch fixture carries." },
  { id: "S-PERSONAL-BROWSER", requirement: "NON_LAUNCH", reason: "The personal browser is off as shipped and needs a published browser image plus a box backend, which no launch fixture carries; the watch page, the take-over lock and the act card are proved at tier 2 with a fake box backend." },
  { id: "S-MEETING-NATIVE-RECAP", requirement: "NON_LAUNCH", reason: "Native recaps are off as shipped and need the org's platform credential stored, which no launch fixture carries; the read, the watch and the recap are proved at tier 2 with a fake platform reader, and the readers against recorded fixtures." },
  { id: "S-MEETING-RECAP", requirement: "NON_LAUNCH", reason: "Meetings are off as shipped and need a published bot image plus a box backend, which no launch fixture carries; the join and the recap are proved at tier 2 with a fake box backend." },
  { id: "S-MEETING-DISCORD-VOICE", requirement: "NON_LAUNCH", reason: "Meetings are off as shipped, and a Discord voice meeting also needs a relay with voice.js and a box backend, which no launch fixture carries; the relay sync, the voice callback and the per-speaker labels are proved offline." },
  { id: "S-EMAIL-ROOM-REPLY", requirement: "NON_LAUNCH", reason: "Email needs a mailbox-service account with inboxes on a test domain the org controls, which no launch fixture carries; the unit packs drive the gate, the front and the reply spine offline." },
  { id: "S-EMAIL-DM-FORWARD", requirement: "NON_LAUNCH", reason: "Same fixture as S-EMAIL-ROOM-REPLY, plus a personal inbox and a principal declaring the sender's address." },
  { id: "S-EMAIL-STRANGER-REFUSED", requirement: "NON_LAUNCH", reason: "Same fixture as S-EMAIL-ROOM-REPLY, plus a stranger inbox on a domain nothing allows." },
  { id: "S-BLOCKED-PING", requirement: "NON_LAUNCH", reason: "The leg reaches the ping only when the model calls update_status with blocked, a model choice no knob here forces, so its green is not a release signal — its hard gates are." },
  { id: "S-STEP-LABELS", requirement: "NON_LAUNCH", reason: "Slack's status line has no read API, so this leg cannot see a step label; its green turns on the model running the named read tool, and the label text is pinned offline." },
  { id: "S-A2A-DELEGATE", requirement: "NON_LAUNCH", reason: "Its fixture is a declared third-party A2A reference agent, which a launch deployment must not declare; it runs on a test deployment." },
  { id: "S-A2A-INBOUND", requirement: "NON_LAUNCH", reason: "Inbound A2A is off as shipped and needs a declared caller, which no launch fixture carries; the authenticated call, the landing and the answer are proved at tier 2." },
] as const;

export const LAUNCH_RELEASE_SCOPE: readonly ReleaseScopeRow[] = [
  ...REQUIRED_IDS.map((id) => ({
    id,
    requirement: "REQUIRED" as const,
    ...(id === "S-DISCORD-GRANT" ? { requiredPhase: "discord-grant-tapped" as const } : {}),
    reason:
      id === "S-DISCORD-GRANT"
        ? "Shared grant.used to grant.notified behavior remains required; built-host coverage is supporting evidence, not deployed live proof. The existing live vehicle requires a Discord owner to tap its real grant card, then the tapped phase must prove grant.used and grant.notified in that retained session."
        : "Launch-surface or shared-invariant acceptance required for this release.",
  })),
  ...NON_LAUNCH_ROWS,
];

export interface ReleaseScopeProblems {
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
  readonly duplicate: readonly string[];
  readonly invalidEquivalent: readonly string[];
  readonly invalidReason: readonly string[];
  readonly invalidPhase: readonly string[];
}

export function releaseScopeProblems(
  rows: readonly ReleaseScopeRow[] = LAUNCH_RELEASE_SCOPE,
  scenarios: readonly Pick<Scenario, "id">[] = SCENARIOS,
): ReleaseScopeProblems {
  const roster = new Set(scenarios.map((scenario) => scenario.id));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const policy = new Set(rows.map((row) => row.id));
  const required = new Set(rows.filter((row) => row.requirement === "REQUIRED").map((row) => row.id));
  return {
    missing: scenarios.map((scenario) => scenario.id).filter((id) => !policy.has(id)),
    unknown: rows.map((row) => row.id).filter((id) => !roster.has(id)),
    duplicate: [...counts].filter(([, count]) => count > 1).map(([id]) => id),
    invalidEquivalent: rows.flatMap((row) => {
      if (row.equivalents === undefined) return [];
      if (row.requirement !== "NON_LAUNCH" || row.equivalents.length === 0) return [`${row.id}-><invalid-set>`];
      const seen = new Set<string>();
      return row.equivalents.flatMap((equivalent) => {
        if (seen.has(equivalent)) return [`${row.id}->${equivalent}:duplicate`];
        seen.add(equivalent);
        return roster.has(equivalent) && required.has(equivalent) ? [] : [`${row.id}->${equivalent}`];
      });
    }),
    invalidReason: rows.filter((row) => row.reason.trim().length === 0).map((row) => row.id),
    invalidPhase: rows.flatMap((row) => {
      const phase = (row as { readonly requiredPhase?: unknown }).requiredPhase;
      if (phase === undefined) return [];
      return row.id === "S-DISCORD-GRANT" && row.requirement === "REQUIRED" && phase === "discord-grant-tapped"
        ? []
        : [`${row.id}:${String(phase)}`];
    }),
  };
}

export function releasePhaseProblem(
  row: ReleaseScopeRow,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (row.requiredPhase === "discord-grant-tapped" && env.E2E_DISCORD_GRANT_TAPPED !== "1") {
    return (
      "S-DISCORD-GRANT requires the human-tapped phase: first raise the Discord-owned grant card, " +
      "have its Discord owner tap Approve, then re-run with E2E_DISCORD_GRANT_TAPPED=1 and the recorded thread. " +
      "The ordinary raising phase proves only grant.asked; it cannot prove grant.used or grant.notified."
    );
  }
  return undefined;
}

export function releaseScopeIndex(rows: readonly ReleaseScopeRow[] = LAUNCH_RELEASE_SCOPE): ReadonlyMap<string, ReleaseScopeRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function releaseScopeRows(name: ReleaseScopeName): readonly ReleaseScopeRow[] {
  if (name === "launch") return LAUNCH_RELEASE_SCOPE;
  return [];
}
