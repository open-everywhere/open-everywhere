export function parseDriverAllowlist(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const pair = entry.trim();
    const sep = pair.indexOf(":");
    if (sep <= 0 || sep === pair.length - 1) continue;
    const guildId = pair.slice(0, sep).trim();
    const botUserId = pair.slice(sep + 1).trim();
    if (!/^\d+$/.test(guildId) || !/^\d+$/.test(botUserId)) continue;
    out.add(`${guildId}:${botUserId}`);
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
