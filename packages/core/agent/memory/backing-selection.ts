import { getSettings } from "../settings/settings.js";

export const MEMORY_PROVIDER_FLOOR = "git";

export function resolveMemoryProviderId(env: NodeJS.ProcessEnv = process.env, selected: string = getSettings().memory.provider): string {
  const explicit = selected.trim();
  if (explicit) return explicit;
  if (env.DATABASE_URL?.trim()) return "postgres";
  return MEMORY_PROVIDER_FLOOR;
}
