import { registerEntityRead, type EntityReadAdapter, type HydrationOutcome } from "./entity-read.js";
import { parseGithubEntityId } from "../scm/issue-actions.js";
import { resolveReadToken } from "../scm/pr-status.js";
import { prApiHeaders, type PrFetchFn } from "../scm/pr.js";

export const GITHUB_ENTITY_PLATFORM = "github";

export interface GithubEntityReadOpts {
  readonly fetchFn?: PrFetchFn;
  readonly apiBase?: string;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly now?: () => Date;
}

export function githubReadStatusOutcome(status: number): "ok" | "gone" | "forbidden" | "error" {
  if (status === 404 || status === 410) return "gone";
  if (status === 401 || status === 403) return "forbidden";
  if (status >= 200 && status < 300) return "ok";
  return "error";
}

export async function readGithubEntity(id: string, opts: GithubEntityReadOpts = {}): Promise<HydrationOutcome> {
  const { repo, number } = parseGithubEntityId(id);
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const token = await (opts.resolveToken ?? resolveReadToken)(repo);
  const res = await fetchFn(`${apiBase}/repos/${repo}/issues/${number}`, { method: "GET", headers: prApiHeaders(token) });
  const kind = githubReadStatusOutcome(res.status);
  if (kind === "gone") return { status: "gone" };
  if (kind === "forbidden") return { status: "forbidden" };
  if (kind === "error") return { status: "error", error: `GitHub entity read failed for ${id}: ${res.status}` };
  const raw = (await res.json()) as {
    title?: unknown;
    state?: unknown;
    body?: unknown;
    html_url?: unknown;
    updated_at?: unknown;
  };
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    status: "ok",
    entity: {
      platform: GITHUB_ENTITY_PLATFORM,
      id,
      ...(str(raw.title) ? { title: str(raw.title)! } : {}),
      ...(str(raw.state) ? { state: str(raw.state)! } : {}),
      ...(str(raw.body) ? { body: str(raw.body)! } : {}),
      ...(str(raw.html_url) ? { url: str(raw.html_url)! } : {}),
      ...(str(raw.updated_at) ? { updatedAt: str(raw.updated_at)! } : {}),
      fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    },
  };
}

export const githubEntityReadAdapter: EntityReadAdapter = {
  platform: GITHUB_ENTITY_PLATFORM,
  readsNetwork: true,
  read(id: string): Promise<HydrationOutcome> {
    return readGithubEntity(id);
  },
};

registerEntityRead(githubEntityReadAdapter);
