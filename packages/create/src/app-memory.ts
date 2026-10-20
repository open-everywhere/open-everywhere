import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function readAppMemoryProvider(cwd: string): Promise<string> {
  const file = join(cwd, "agent", "settings", "settings.ts");
  if (!existsSync(file)) return "";
  try {
    const mod = (await import(pathToFileURL(file).href)) as { SETTINGS_OVERRIDES?: { memory?: Record<string, unknown> } };
    const provider = mod.SETTINGS_OVERRIDES?.memory?.["provider"];
    return typeof provider === "string" ? provider.trim() : "";
  } catch {
    return "";
  }
}
