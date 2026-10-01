export const DEPLOY_PROBE_PATH = "/eve/v1/slack";

export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export function normalizeHost(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    return undefined;
  }
}

interface Attempt extends ProbeResult {
  readonly retry: boolean;
  readonly brief: string;
}

async function probeOnce(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, retry: true, brief: `no answer within ${timeoutMs / 1000}s`, detail: `${url} did not answer (${why})` };
  }
  const body = (await res.text().catch(() => "")).trim();
  if (res.status === 401 && body === "unauthorized") {
    return {
      ok: true,
      retry: false,
      brief: "401 unauthorized",
      detail: `${url} answered 401 unauthorized to an unsigned request: the function booted and the Slack route is mounted. This does NOT prove the deployment holds SLACK_SIGNING_SECRET (the route answers the same without it). Slack proves that: Event Subscriptions shows the request URL as Verified`,
    };
  }
  const fail = (detail: string, retry = false): Attempt => ({ ok: false, retry, brief: `${res.status}`, detail });
  if (res.status === 401 || res.status === 403) {
    return fail(
      `${url} answered ${res.status}, but not from the Slack route — Vercel Deployment Protection (or a proxy) blocks it, and it blocks Slack too. Vercel project → Settings → Deployment Protection`,
    );
  }
  if (res.status === 404) return fail(`${url} answered 404: the Slack route is not on this deployment (wrong host, or the roster does not mount Slack)`);
  if (res.status >= 500) return fail(`${url} answered ${res.status}: the function failed — read the deployment's logs (\`npx vercel logs <host>\`)`, true);
  return fail(`${url} answered ${res.status}: expected 401 to an unsigned request`);
}

export async function probeDeployment(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
  retryTimeoutMs = 30_000,
): Promise<ProbeResult> {
  const url = `${origin}${DEPLOY_PROBE_PATH}`;
  const first = await probeOnce(url, fetchImpl, timeoutMs);
  if (first.ok || !first.retry) return { ok: first.ok, detail: first.detail };
  const second = await probeOnce(url, fetchImpl, retryTimeoutMs);
  if (second.ok) return { ok: true, detail: `cold start: the first request got ${first.brief}, and the retry passed. ${second.detail}` };
  return { ok: false, detail: `${second.detail} (after one retry; the first request got ${first.brief})` };
}
