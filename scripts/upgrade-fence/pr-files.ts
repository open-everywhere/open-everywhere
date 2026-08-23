export type FenceFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

const PER_PAGE = 100;
const MAX_PAGES = 30;

export async function listPullRequestFiles(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: FenceFetchFn;
  apiBase?: string;
}): Promise<string[]> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FenceFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const files = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiBase}/repos/${opts.repo}/pulls/${opts.number}/files?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);

    const batch = (await res.json()) as { filename?: string; previous_filename?: string }[];
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
