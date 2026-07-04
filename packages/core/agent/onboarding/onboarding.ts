import { isPinnedStatusMessage } from "../status/status.js";
import { SURFACE } from "../memory/store.js";
import { getProvider } from "../memory/provider.js";
import type { Partition } from "../memory/partition.js";

export const ONBOARDED_MARKER = "_onboarded";

export async function isSurfaceOnboarded(p: Partition): Promise<boolean> {
  const marker = await getProvider().ensureTier(p, SURFACE);
  return marker[ONBOARDED_MARKER] !== undefined;
}

export async function markSurfaceOnboarded(p: Partition): Promise<void> {
  const provider = getProvider();
  const marker = await provider.ensureTier(p, SURFACE);
  if (marker[ONBOARDED_MARKER] !== undefined) return;
  marker[ONBOARDED_MARKER] = new Date().toISOString();
  await provider.writeTier(p, SURFACE, marker, `onboarding ${p.surfaceKey}`);
}

export function extractPinnedInstructions(pinsList: unknown): string | null {
  const items = (pinsList as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  const texts: string[] = [];
  for (const it of items) {
    const m = (it as { message?: { text?: unknown } })?.message;
    if (m && typeof m.text === "string") {
      const t = m.text.trim();
      if (t && !isPinnedStatusMessage(t)) texts.push(t);
    }
  }
  return texts.length ? texts.join("\n\n") : null;
}

export function introMessage(adoptedInstructions: boolean, name?: string): string {
  const base = `👋 Hi, I'm **${name?.trim() || "Open Everywhere"}** — an autonomous engineering teammate. Tag me with a task (investigate a bug, draft a PR, watch something on a schedule) and I'll work it through and report back. Consequential actions pause for your approval.`;
  return adoptedInstructions
    ? `${base}\n\nI've read this channel's pinned message and will treat it as my standing instructions here.`
    : base;
}

export function instructionBullet(text: string, dateISO: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return `- ${dateISO}: (from pinned message) ${collapsed}`;
}
