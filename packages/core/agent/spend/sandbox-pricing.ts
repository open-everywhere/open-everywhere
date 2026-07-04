const DEFAULT_SANDBOX_MEMORY_GIB = 4;

const DEFAULT_SANDBOX_GIB_HOUR_USD = 0.0212;

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function sandboxMemoryGiB(): number {
  return envFloat("OE_SANDBOX_MEMORY_GIB", DEFAULT_SANDBOX_MEMORY_GIB);
}

export function sandboxGiBHourUsd(): number {
  return envFloat("OE_SANDBOX_GIB_HOUR_USD", DEFAULT_SANDBOX_GIB_HOUR_USD);
}

export function estimateSandboxCostUsd(totalSeconds: number): number {
  const hours = Math.max(0, totalSeconds) / 3600;
  return hours * sandboxMemoryGiB() * sandboxGiBHourUsd();
}
