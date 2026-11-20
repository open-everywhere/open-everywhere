// Adapted from eve 1.0.0-rc.18 (Copyright 2026 Vercel, Inc. and contributors, Apache-2.0),
// `src/public/channels/teams/api`. The Open Everywhere authors changed it: eve 1.0 no longer
// exports the splitter, so the Teams post arm owns its copy. The cap and the cut points match eve's.

/** The longest text one outbound Teams activity carries before the post arm splits it (80 KiB). */
export const TEAMS_MESSAGE_TEXT_MAX_LENGTH = 81920;

/**
 * Splits `content` into parts no longer than {@link TEAMS_MESSAGE_TEXT_MAX_LENGTH}. It cuts on a
 * paragraph break, then a line break, then a space, and only then mid-word. Text that fits comes
 * back as one part.
 */
export function splitTeamsMessageText(content: string): readonly string[] {
  if (content.length <= TEAMS_MESSAGE_TEXT_MAX_LENGTH) return [content];
  const parts: string[] = [];
  let rest = content;
  while (rest.length > TEAMS_MESSAGE_TEXT_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n\n", TEAMS_MESSAGE_TEXT_MAX_LENGTH);
    if (cut <= 0) cut = rest.lastIndexOf("\n", TEAMS_MESSAGE_TEXT_MAX_LENGTH);
    if (cut <= 0) cut = rest.lastIndexOf(" ", TEAMS_MESSAGE_TEXT_MAX_LENGTH);
    if (cut <= 0) cut = TEAMS_MESSAGE_TEXT_MAX_LENGTH;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  return parts;
}
