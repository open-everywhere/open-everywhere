export interface Titled {
  readonly name: string;
  readonly title?: string;
}

export function displayTitle(x: Titled | undefined): string | undefined {
  if (!x) return undefined;
  const t = x.title?.trim();
  return t && t.length > 0 ? t : x.name;
}
