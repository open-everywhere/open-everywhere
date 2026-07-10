const IP_WINDOW_MS = 60_000;
const IP_MAX_PER_WINDOW = 60;

const hits = new Map<string, { count: number; windowStart: number }>();

export function checkIpRateLimit(ip: string, now: number = Date.now()): boolean {
  const existing = hits.get(ip);
  if (!existing || now - existing.windowStart >= IP_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  existing.count += 1;
  return existing.count <= IP_MAX_PER_WINDOW;
}

export function firstForwardedIp(headerValue: string | string[] | undefined): string {
  if (!headerValue) return "unknown";
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const first = raw?.split(",")[0]?.trim();
  return first || "unknown";
}

export function __clearIpRateLimitForTest(): void {
  hits.clear();
}
