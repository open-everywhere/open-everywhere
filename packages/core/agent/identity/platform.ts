const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  "discord-gateway": "discord",
};

const PLATFORM_PREFIXES: readonly string[] = ["slack", "discord", "teams", "linear"];

export function normalizePlatform(bare: string | undefined): string | undefined {
  if (!bare) return bare;
  const aliased = PLATFORM_ALIASES[bare];
  if (aliased) return aliased;
  for (const p of PLATFORM_PREFIXES) {
    if (bare.startsWith(`${p}-`)) return p;
  }
  return bare;
}

export function platformFromKind(rawKind: string | undefined): string | undefined {
  const bare = rawKind && rawKind.includes(":") ? rawKind.slice(rawKind.lastIndexOf(":") + 1) : rawKind;
  return normalizePlatform(bare);
}
