const DISCORD_PAIR = /^\d+:\d+$/;

const SLACK_DRIVER_PAIR = /^T[A-Z0-9]+:B[A-Z0-9]+$/;

export interface E2eDriverIdentity {
  readonly surface: string;
  readonly principal: string;
}

const DRIVER_SURFACE = /^[a-z][a-z0-9-]*$/;

export function e2eDriversProblem(value: unknown): string | undefined {
  const bad = "must be an array of { surface, principal } entries, each naming ONE bot identity (e.g. { surface: \"slack\", principal: \"T0123ABCD:B0456EFGH\" })";
  if (!Array.isArray(value)) return bad;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return bad;
    const { surface, principal } = entry as { surface?: unknown; principal?: unknown };
    if (typeof surface !== "string" || !DRIVER_SURFACE.test(surface)) return bad;
    if (typeof principal !== "string" || principal.trim() === "" || /\s/u.test(principal)) return bad;
    if (surface === "slack" && !SLACK_DRIVER_PAIR.test(principal)) {
      return 'a "slack" principal must be a `teamId:botId` pair (e.g. "T0123ABCD:B0456EFGH")';
    }
  }
  return undefined;
}

export function e2eDriverPrincipals(configured: readonly E2eDriverIdentity[], surface: string): readonly string[] {
  return configured.filter((d) => d.surface === surface).map((d) => d.principal);
}

function driverPrincipalFor(surface: string, workspace: string | undefined, authorId: string | undefined): string | undefined {
  if (authorId === undefined || authorId === "") return undefined;
  if (surface !== "slack") return authorId;
  if (workspace === undefined || workspace === "") return undefined;
  return `${workspace}:${authorId}`;
}

export function isE2eDriver(
  configured: readonly E2eDriverIdentity[],
  surface: string,
  workspace: string | undefined,
  authorId: string | undefined,
): boolean {
  const principal = driverPrincipalFor(surface, workspace, authorId);
  if (principal === undefined) return false;
  return configured.some((d) => d.surface === surface && d.principal === principal);
}

export function parseDriverAllowlist(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const pair = entry.trim();
    if (DISCORD_PAIR.test(pair) || SLACK_DRIVER_PAIR.test(pair)) out.add(pair);
  }
  return out;
}

export function isAllowedDriver(
  guildId: string | undefined,
  botUserId: string,
  allowlist: ReadonlySet<string> = parseDriverAllowlist(process.env.OE_TEST_DRIVER_IDS),
): boolean {
  if (!guildId || !botUserId) return false;
  return allowlist.has(`${guildId}:${botUserId}`);
}

export function isAllowedSlackDriver(
  teamId: string | undefined,
  botId: string | undefined,
  allowlist: ReadonlySet<string> = parseDriverAllowlist(process.env.OE_TEST_DRIVER_IDS),
): boolean {
  if (!teamId || !botId) return false;
  return allowlist.has(`${teamId}:${botId}`);
}

export function isAllowlistedDriverAuthor(
  workspace: string | undefined,
  authorId: string | undefined,
  allowlist: ReadonlySet<string> = parseDriverAllowlist(process.env.OE_TEST_DRIVER_IDS),
): boolean {
  if (!workspace || !authorId) return false;
  return allowlist.has(`${workspace}:${authorId}`);
}
