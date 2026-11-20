import type { SessionView } from "eve/events";
import { interaction } from "eve/events";

export function deliveredText(data: unknown): string | undefined {
  const parts = (data as { readonly parts?: unknown } | null | undefined)?.parts;
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const raw of parts as readonly unknown[]) {
    const part = raw as { readonly kind?: unknown; readonly text?: unknown } | null;
    if (part?.kind === "text" && typeof part.text === "string") texts.push(part.text);
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}

export function interactionKindOf(view: SessionView | undefined, interactionId: unknown): string | undefined {
  if (view === undefined || typeof interactionId !== "string" || interactionId.length === 0) return undefined;
  try {
    return interaction(view, interactionId)?.request.kind;
  } catch {
    return undefined;
  }
}
