import { getSettings } from "../settings/settings.js";

export function sandboxMemoryGiB(): number {
  return getSettings().spend.sandboxMemoryGiB;
}

export function sandboxGiBHourUsd(): number {
  return getSettings().spend.sandboxGiBHourUsd;
}

export function estimateSandboxCostUsd(totalSeconds: number): number {
  const hours = Math.max(0, totalSeconds) / 3600;
  return hours * sandboxMemoryGiB() * sandboxGiBHourUsd();
}
