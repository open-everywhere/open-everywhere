export function commentAtOrAfter(createdAt: string, boundIso: string): boolean {
  const at = Date.parse(createdAt);
  const bound = Date.parse(boundIso);
  if (Number.isNaN(at) || Number.isNaN(bound)) return true;
  return at >= Math.floor(bound / 1000) * 1000;
}
