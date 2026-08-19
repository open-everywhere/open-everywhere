export type PlatformFailureClass = "definitive" | "ambiguous";

const AMBIGUOUS_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

export function platformFailureStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

export function platformFailureClass(err: unknown): PlatformFailureClass {
  if ((err as { applied?: unknown } | null | undefined)?.applied === false) return "definitive";
  const status = platformFailureStatus(err);
  if (status !== undefined && status >= 400 && status < 500 && !AMBIGUOUS_CLIENT_STATUSES.has(status)) return "definitive";
  return "ambiguous";
}

export function markNotApplied<E extends Error>(err: E): E {
  return Object.assign(err, { applied: false as const });
}

export function carryFailureSignals<E extends Error>(from: unknown, to: E): E {
  const applied = (from as { applied?: unknown } | null | undefined)?.applied;
  if (applied === false) markNotApplied(to);
  const status = platformFailureStatus(from);
  if (status !== undefined) Object.assign(to, { status });
  return to;
}
