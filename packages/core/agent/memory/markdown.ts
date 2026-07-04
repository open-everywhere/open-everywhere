function findSection(lines: readonly string[], sectionTitle: string): { headingIdx: number; end: number } | null {
  const headingIdx = lines.findIndex((l) => l.trim().toLowerCase() === `## ${sectionTitle}`.toLowerCase());
  if (headingIdx === -1) return null;
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { headingIdx, end };
}

export function upsertUnderSection(
  content: string,
  sectionTitle: string,
  bullet: string,
): string {
  const line = bullet.startsWith("- ") ? bullet : `- ${bullet}`;
  const lines = content.split("\n");
  const found = findSection(lines, sectionTitle);

  if (!found) {
    const tail = content.endsWith("\n") ? "" : "\n";
    return `${content}${tail}\n## ${sectionTitle}\n${line}\n`;
  }
  const { headingIdx, end } = found;

  const section = lines.slice(headingIdx + 1, end);
  const cleaned = section.filter((l) => l.trim().toLowerCase() !== "(none yet)");

  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
  cleaned.push(line, "");

  return [...lines.slice(0, headingIdx + 1), ...cleaned, ...lines.slice(end)].join("\n");
}

export function sectionBullets(content: string, sectionTitle: string): string[] {
  const lines = content.split("\n");
  const found = findSection(lines, sectionTitle);
  if (!found) return [];
  return lines
    .slice(found.headingIdx + 1, found.end)
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.trim());
}

export function appendToTopicFile(content: string | undefined, title: string, bullet: string): string {
  const line = bullet.startsWith("- ") ? bullet : `- ${bullet}`;
  const base = content && content.trim().length > 0 ? content : `# ${title}\n`;
  return `${base.replace(/\n+$/, "")}\n${line}\n`;
}

export function trimSectionToRecent(
  content: string,
  sectionTitle: string,
  n: number,
): { content: string; overflow: string[] } {
  const cap = Math.max(0, n);
  const lines = content.split("\n");
  const found = findSection(lines, sectionTitle);
  if (!found) return { content, overflow: [] };
  const { headingIdx, end } = found;

  const section = lines.slice(headingIdx + 1, end);
  const bulletIdx: number[] = [];
  section.forEach((l, i) => {
    if (/^\s*-\s+/.test(l)) bulletIdx.push(i);
  });
  if (bulletIdx.length <= cap) return { content, overflow: [] };

  const overflowCount = bulletIdx.length - cap;
  const overflowSet = new Set(bulletIdx.slice(0, overflowCount));
  const overflow = bulletIdx.slice(0, overflowCount).map((i) => section[i].trim());
  const keptSection = section.filter((_, i) => !overflowSet.has(i));

  return {
    content: [...lines.slice(0, headingIdx + 1), ...keptSection, ...lines.slice(end)].join("\n"),
    overflow,
  };
}

export function ensureFullHistoryPointer(content: string, sectionTitle: string, topicNode: string): string {
  const pointer = `_Full history: [[${topicNode}]]_`;
  const lines = content.split("\n");
  const found = findSection(lines, sectionTitle);
  if (!found) return content;
  const { headingIdx, end } = found;

  const section = lines.slice(headingIdx + 1, end);
  if (section.some((l) => l.trim() === pointer)) return content;

  const cleaned = [...section];
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
  cleaned.push(pointer, "");

  return [...lines.slice(0, headingIdx + 1), ...cleaned, ...lines.slice(end)].join("\n");
}
