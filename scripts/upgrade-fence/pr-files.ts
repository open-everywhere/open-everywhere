export type FenceFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

const PER_PAGE = 100;
const MAX_PAGES = 30;
const REQUEST_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 60_000;

export class FenceFetchTimeoutError extends Error {
  readonly reason = "fetch-timeout";
  constructor(message: string) {
    super(message);
    this.name = "FenceFetchTimeoutError";
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new FenceFetchTimeoutError(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function listPullRequestFiles(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: FenceFetchFn;
  apiBase?: string;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  now?: () => number;
}): Promise<string[]> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FenceFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const files = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiBase}/repos/${opts.repo}/pulls/${opts.number}/files?per_page=${PER_PAGE}&page=${page}`;

    const remaining = totalTimeoutMs - (now() - startedAt);
    if (remaining <= 0) {
      throw new FenceFetchTimeoutError(
        `listing the files of pull request #${opts.number} outlasted its ${totalTimeoutMs} ms budget at page ${page} — ` +
          "the fence cannot see the whole diff and refuses to report on a partial one.",
      );
    }
    const budget = Math.min(requestTimeoutMs, remaining);

    const batch = await withDeadline(
      (async () => {
        const res = await fetchFn(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${opts.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(budget),
        });
        if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as { filename?: string; previous_filename?: string }[];
      })(),
      budget,
      `GET ${url} did not answer within ${budget} ms — refusing rather than report on a diff it could not read.`,
    );

    if (!Array.isArray(batch)) throw new Error(`GET ${url} returned a non-array body`);
    for (const entry of batch) {
      if (typeof entry.filename === "string") files.add(entry.filename);
      if (typeof entry.previous_filename === "string") files.add(entry.previous_filename);
    }
    if (batch.length < PER_PAGE) return [...files].sort();
  }

  throw new Error(
    `pull request #${opts.number} changes more than ${MAX_PAGES * PER_PAGE} files — GitHub truncates the listing there, ` +
      `so the fence cannot see the whole diff and refuses to report on a partial one.`,
  );
}
