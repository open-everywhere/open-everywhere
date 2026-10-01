export type OperationalFloor = "pglite" | "sqlite" | "none";

export function resolveOperationalSelection(env: NodeJS.ProcessEnv = process.env): { id: string; floor: OperationalFloor } {
  const explicit = env.OE_OPERATIONAL_PROVIDER?.trim();
  if (explicit) return { id: explicit, floor: explicit === "sqlite" ? "sqlite" : "none" };
  if (!env.DATABASE_URL?.trim()) return { id: "postgres", floor: "pglite" };
  return { id: "sqlite", floor: "sqlite" };
}
