const DISCORD_PAIR = /^\d+:\d+$/;

export const SLACK_DRIVER_PAIR = /^T[A-Z0-9]+:B[A-Z0-9]+$/;

export function slackDmDriverPairs(configured: readonly string[] | string): readonly string[] {
  const raw = typeof configured === "string" ? [configured] : configured;
  return raw.filter((pair) => pair !== "");
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
