const MARKER_RE = /^<!-- oe:human-edit edited_by="human" edited_at="([^"]*)" -->\n?/;

export function stampHumanEdit(content: string, at: Date = new Date()): string {
  const stripped = content.replace(MARKER_RE, "");
  return `<!-- oe:human-edit edited_by="human" edited_at="${at.toISOString()}" -->\n${stripped}`;
}

export function isHumanEdited(content: string): boolean {
  return MARKER_RE.test(content);
}

export function humanEditedAt(content: string): string | null {
  return content.match(MARKER_RE)?.[1] ?? null;
}

export function humanEditedFiles(files: Readonly<Record<string, string>>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [rel, content] of Object.entries(files)) {
    if (isHumanEdited(content)) out.add(rel);
  }
  return out;
}
