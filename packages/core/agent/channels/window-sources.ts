import { isTaskWindowId } from "./window-key.js";
import type { Domain } from "../memory/domain.js";

function platformOf(surfaceKey: string): string {
  return surfaceKey.split("/", 1)[0] ?? "";
}

function distinctPlatforms(channels: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of channels) {
    const p = platformOf(ch);
    if (p.length > 0 && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function sourcesForWindow(windowId: string, domain: string, domains: readonly Domain[]): readonly string[] {
  if (isTaskWindowId(windowId)) {
    const p = platformOf(windowId.slice("t/".length));
    return p.length > 0 ? [p] : [];
  }
  if (windowId === domain) {
    const d = domains.find((dm) => dm.name === domain);
    return distinctPlatforms(d?.channels ?? []);
  }
  const p = platformOf(windowId);
  return p.length > 0 ? [p] : [];
}

export function encodeSources(sources: readonly string[]): string {
  return sources.join(",");
}

export function decodeSources(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
