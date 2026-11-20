const OE_PREFIX = "open-everywhere.";

export function resetProcessGlobals(): void {
  const g = globalThis as unknown as { [k: symbol]: unknown; [k: string]: unknown };
  for (const key of Object.getOwnPropertySymbols(globalThis)) {
    if (!key.description?.startsWith(OE_PREFIX)) continue;
    const value = g[key];
    if (value instanceof Map) {
      value.clear();
    } else if (value instanceof Object && "oeSlot" in (value as object)) {
      (value as { oeSlot: unknown }).oeSlot = null;
    }
  }
}
