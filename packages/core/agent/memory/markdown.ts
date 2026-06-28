export function upsertUnderSection(
  content: string,
  sectionTitle: string,
  bullet: string,
): string {
  const line = bullet.startsWith("- ") ? bullet : `- ${bullet}`;
  const lines = content.split("\n");
  const headingIdx = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${sectionTitle}`.toLowerCase(),
  );

  if (headingIdx === -1) {
    const tail = content.endsWith("\n") ? "" : "\n";
    return `${content}${tail}\n## ${sectionTitle}\n${line}\n`;
  }

  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }

  const section = lines.slice(headingIdx + 1, end);
  const cleaned = section.filter((l) => l.trim().toLowerCase() !== "(none yet)");

  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
  cleaned.push(line, "");

  return [...lines.slice(0, headingIdx + 1), ...cleaned, ...lines.slice(end)].join("\n");
}
