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
