export function ageAtRead(itemAt: string | undefined, readAt: string | undefined): string | undefined {
  if (!itemAt || !readAt) return undefined;
  const then = Date.parse(itemAt);
  const now = Date.parse(readAt);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return undefined;
  const ms = now - then;
  if (ms < 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
