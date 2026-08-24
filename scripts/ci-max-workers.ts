export function ciMaxWorkersOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OE_IT_CI_MAX_WORKERS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}
