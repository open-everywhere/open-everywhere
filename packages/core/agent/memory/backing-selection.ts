export const MEMORY_PROVIDER_FLOOR = "git";

export function resolveMemoryProviderId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OE_MEMORY_PROVIDER?.trim();
  if (explicit) return explicit;
  if (env.DATABASE_URL?.trim()) return "postgres";
  return MEMORY_PROVIDER_FLOOR;
}
