export const LINK_SET_REF_PREFIX = "linkSet:";

export function isLinkSetRef(value: string): boolean {
  return value.startsWith(LINK_SET_REF_PREFIX);
}

export function parseLinkSetRef(value: string): string | undefined {
  if (!value.startsWith(LINK_SET_REF_PREFIX)) return undefined;
  const id = value.slice(LINK_SET_REF_PREFIX.length);
  if (id.length === 0 || /[/\s]/u.test(id)) return undefined;
  return id;
}

export function isValidLinkSetRef(value: string): boolean {
  return parseLinkSetRef(value) !== undefined;
}

export function linkSetRefMatches(ref: string, callerLinkSets: Iterable<string>): boolean {
  const id = parseLinkSetRef(ref);
  if (id === undefined) return false;
  for (const s of callerLinkSets) if (s === id) return true;
  return false;
}

export function rosterHasLinkSet(roster: readonly string[] | undefined, callerLinkSets: readonly string[]): boolean {
  if (!roster || roster.length === 0 || callerLinkSets.length === 0) return false;
  const mine = new Set(callerLinkSets);
  for (const entry of roster) {
    const id = parseLinkSetRef(entry);
    if (id !== undefined && mine.has(id)) return true;
  }
  return false;
}
