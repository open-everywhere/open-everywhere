import {
  catchUpSender,
  resolveSurfaceReadToken,
  type NormalizedMessage,
  type PrFetchFn,
  type SeatCatchUpFetch,
} from "@open-everywhere/core/agent/adapter-api.js";
import { getJson, liveGithubReadFetch, parseGithubContainer } from "./github-read.js";

const API_BASE = "https://api.github.com";

const CATCH_UP_PAGE_LIMIT = 100;

interface RawTimelineComment {
  readonly id?: number;
  readonly body?: string | null;
  readonly created_at?: string;
  readonly user?: { readonly login?: string; readonly type?: string };
}

function normalizeComment(c: RawTimelineComment, selfLogin: string | undefined): NormalizedMessage | undefined {
  const login = c.user?.login;
  if (!login) return undefined;
  const text = (c.body ?? "").trim();
  if (text.length === 0) return undefined;
  const ms = Date.parse(c.created_at ?? "");
  if (!Number.isFinite(ms)) return undefined;
  const isBot = c.user?.type === "Bot";
  const isSelf = selfLogin !== undefined && login.toLowerCase() === selfLogin.toLowerCase();
  return {
    id: String(c.id ?? `${login}@${c.created_at ?? ms}`),
    ms,
    ...(isSelf ? {} : { authorId: login }),
    sender: catchUpSender({ self: isSelf, bot: isBot }),
    type: "channel",
    text,
  };
}

export interface GitHubCatchUpDeps {
  readonly fetchFn: PrFetchFn;
  readonly resolveToken?: (repoFull: string) => Promise<string>;
  readonly selfLogin?: string;
}

const liveDeps: GitHubCatchUpDeps = {
  fetchFn: liveGithubReadFetch,
  selfLogin: process.env.GITHUB_APP_SLUG ? `${process.env.GITHUB_APP_SLUG}[bot]` : undefined,
};

export async function fetchGitHubCatchUpWindow(
  req: { container: string; sinceMs: number },
  deps: GitHubCatchUpDeps = liveDeps,
): Promise<readonly NormalizedMessage[]> {
  const target = parseGithubContainer(req.container);
  if (!target) return [];
  const token = await (deps.resolveToken ?? resolveSurfaceReadToken)(target.repoFull);
  const since = new Date(req.sinceMs).toISOString();
  const url = `${API_BASE}/repos/${target.repoFull}/issues/${target.number}/comments?per_page=${CATCH_UP_PAGE_LIMIT}&since=${encodeURIComponent(since)}`;
  const raw = await getJson<readonly RawTimelineComment[]>(deps.fetchFn, url, token, "issues.listComments");
  if (!Array.isArray(raw)) throw new Error("GitHub catch-up returned a malformed response");
  const out: NormalizedMessage[] = [];
  for (const c of raw) {
    const n = normalizeComment(c, deps.selfLogin);
    if (n) out.push(n);
  }
  return out;
}

export const GITHUB_TIMESTAMP_PRECISION_MS = 1_000;

export const githubSeatCatchUpFetch: SeatCatchUpFetch = (req) => fetchGitHubCatchUpWindow({ container: req.container, sinceMs: req.sinceMs });
