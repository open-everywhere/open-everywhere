import { PINNED_HEADER } from "../status/status.js";

export const ONBOARDED_MARKER = "_onboarded";

export function extractPinnedInstructions(pinsList: unknown): string | null {
  const items = (pinsList as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  const texts: string[] = [];
  for (const it of items) {
    const m = (it as { message?: { text?: unknown } })?.message;
    if (m && typeof m.text === "string") {
      const t = m.text.trim();
      if (t && !t.startsWith(PINNED_HEADER)) texts.push(t);
    }
  }
  return texts.length ? texts.join("\n\n") : null;
}

export function introMessage(adoptedInstructions: boolean): string {
  const base =
    "👋 Hi, I'm **OpenEverywhere** — an autonomous engineering teammate. Tag me with a task (investigate a bug, draft a PR, watch something on a schedule) and I'll work it through and report back. Consequential actions pause for your approval.";
  return adoptedInstructions
    ? `${base}\n\nI've read this channel's pinned message and will treat it as my standing instructions here.`
    : base;
}

export function instructionBullet(text: string, dateISO: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return `- ${dateISO}: (from pinned message) ${collapsed}`;
}
