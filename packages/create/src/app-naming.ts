import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface AppNaming {
  readonly agentName?: string;
  readonly commandName?: string;
}

export async function readAppNaming(cwd: string): Promise<AppNaming> {
  const file = join(cwd, "agent", "settings", "settings.ts");
  if (!existsSync(file)) return {};
  try {
    const mod = (await import(pathToFileURL(file).href)) as { SETTINGS_OVERRIDES?: { identity?: Record<string, unknown> } };
    return namingFromIdentity(mod.SETTINGS_OVERRIDES?.identity);
  } catch {
    return {};
  }
}

export function namingFromIdentity(identity: Record<string, unknown> | undefined): AppNaming {
  const name = typeof identity?.["name"] === "string" ? identity["name"].trim() : "";
  const command = typeof identity?.["commandName"] === "string" ? identity["commandName"].trim() : "";
  return {
    ...(name === "" ? {} : { agentName: name }),
    ...(command === "" ? {} : { commandName: command }),
  };
}
