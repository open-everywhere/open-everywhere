export type WorkState = "working" | "done" | "needs_input" | "blocked";

export const STATUS_REACTION = {
  working: "eyes",
  blocked: "octagonal_sign",
} as const;
export type ReactionState = keyof typeof STATUS_REACTION;
export const ALL_STATUS_REACTIONS: readonly string[] = Object.values(STATUS_REACTION);

export const STOP_HAND_SLACK_NAME = "raised_hand";
export const STOP_HAND_UNICODE = "✋";

const ICON: Record<WorkState, string> = {
  working: "⏳",
  done: "✅",
  needs_input: "❓",
  blocked: "🛑",
};

export const PINNED_HEADER = "*Open Everywhere — current work*";

export const PINNED_HEADERS: readonly string[] = [PINNED_HEADER, "*OpenEverywhere — current work*"];

export function isPinnedStatusMessage(text: string): boolean {
  return PINNED_HEADERS.some((h) => text.startsWith(h));
}

function isItem(line: string): boolean {
  return line.startsWith("- ");
}
function idOf(line: string): string | null {
  const m = line.match(/`([^`]+)`/);
  return m ? m[1] : null;
}

export function statusItemLine(id: string, state: WorkState, summary: string, whenISO: string): string {
  return `- ${ICON[state]} ${summary.trim().replace(/\s+/g, " ")} · \`${id}\` · ${whenISO}`;
}

export function upsertStatusItem(body: string | undefined, id: string, line: string | null): string {
  const lines = (body ?? "").split("\n");
  const out: string[] = [];
  let replaced = false;
  for (const l of lines) {
    if (isItem(l) && idOf(l) === id) {
      if (line) {
        out.push(line);
        replaced = true;
      }
    } else {
      out.push(l);
    }
  }
  if (line && !replaced) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function statusItems(body: string | undefined): string[] {
  return (body ?? "").split("\n").filter(isItem);
}

export function renderPinned(body: string | undefined): string {
  const items = statusItems(body);
  return items.length ? `${PINNED_HEADER}\n${items.join("\n")}` : `${PINNED_HEADER}\n_(idle)_`;
}

export function statusSeed(surfaceKey: string): string {
  return `# Status — ${surfaceKey}\n\nOpen Everywhere's in-flight work on this surface (one line per thread). Maintained by the \`update_status\` tool; mirrored to a pinned Slack message.\n`;
}
