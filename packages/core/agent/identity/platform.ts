const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  "discord-gateway": "discord",
};

export function normalizePlatform(bare: string | undefined): string | undefined {
  return bare ? (PLATFORM_ALIASES[bare] ?? bare) : bare;
}

export function platformFromKind(rawKind: string | undefined): string | undefined {
  const bare = rawKind && rawKind.includes(":") ? rawKind.slice(rawKind.lastIndexOf(":") + 1) : rawKind;
  return normalizePlatform(bare);
}
