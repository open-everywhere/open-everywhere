import { AUDIT_SINCE_SKEW_MS } from "./gate-joins.js";

export interface ClockSkew {
  readonly skewMs: number;
  readonly uncertaintyMs: number;
}

export function clockSkewFromDateHeader(dateHeader: string | null | undefined, sentMs: number, receivedMs: number): ClockSkew | undefined {
  if (typeof dateHeader !== "string" || dateHeader.trim().length === 0) return undefined;
  const headerMs = Date.parse(dateHeader);
  if (!Number.isFinite(headerMs) || !Number.isFinite(sentMs) || !Number.isFinite(receivedMs) || receivedMs < sentMs) return undefined;
  const driverMidMs = (sentMs + receivedMs) / 2;
  return { skewMs: Math.round(headerMs + 500 - driverMidMs), uncertaintyMs: Math.round(500 + (receivedMs - sentMs) / 2) };
}

const secs = (ms: number): string => (Math.abs(ms) / 1000).toFixed(1);

export function renderClockSkewLine(skew: ClockSkew | undefined, unavailable?: string): string {
  if (skew === undefined) {
    return `clock skew: not measured (${unavailable ?? "no Date header"}) — driver-clock audit windows in this run have an unknown error against the deployment's ts`;
  }
  const within = Math.abs(skew.skewMs) <= skew.uncertaintyMs;
  const head = within
    ? `clock skew: the driver clock agrees with the deployment within the measure (${skew.skewMs >= 0 ? "+" : "-"}${secs(skew.skewMs)} s, ±${secs(skew.uncertaintyMs)} s, Date header)`
    : `clock skew: the driver clock is ${secs(skew.skewMs)} s ${skew.skewMs > 0 ? "BEHIND" : "AHEAD OF"} the deployment (±${secs(skew.uncertaintyMs)} s, Date header)`;
  if (Math.abs(skew.skewMs) - skew.uncertaintyMs <= AUDIT_SINCE_SKEW_MS) return head;
  return (
    `${head} — 🔴 MORE than the ${AUDIT_SINCE_SKEW_MS / 1000} s margin a driver-clock audit window takes (AUDIT_SINCE_SKEW_MS). ` +
    (skew.skewMs > 0
      ? "A driver-clock window opens early in deployment time and can take in a previous step's rows."
      : "A driver-clock window opens late in deployment time and can miss the rows a step caused.")
  );
}

export async function measureDeploymentClockSkew(
  targetUrl: string,
  deps: { readonly fetch?: typeof fetch; readonly now?: () => number; readonly timeoutMs?: number } = {},
): Promise<{ readonly skew?: ClockSkew; readonly unavailable?: string }> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  try {
    const sentMs = now();
    const res = await doFetch(targetUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    const receivedMs = now();
    await res.body?.cancel().catch(() => undefined);
    const skew = clockSkewFromDateHeader(res.headers.get("date"), sentMs, receivedMs);
    return skew === undefined ? { unavailable: `the response from ${targetUrl} carried no readable Date header` } : { skew };
  } catch (err) {
    return { unavailable: `GET ${targetUrl} failed: ${String(err instanceof Error ? err.message : err)}` };
  }
}
