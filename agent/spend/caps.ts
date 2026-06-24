import type { Caps } from "./spend.js";

interface CapConfig {
  readonly default?: Caps;
  readonly perWorkspace?: Readonly<Record<string, Caps>>;
  readonly perSurface?: Readonly<Record<string, Caps>>;
}

const CONFIG: CapConfig = {};

export function resolveCaps(workspaceKey: string, surfaceKey: string): Caps {
  return CONFIG.perSurface?.[surfaceKey] ?? CONFIG.perWorkspace?.[workspaceKey] ?? CONFIG.default ?? {};
}
