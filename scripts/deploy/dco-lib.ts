import {
  fetchGithubApi,
  type GithubApiFetchLike,
  GITHUB_API_PAGE_SIZE,
  realGithubApiFetch,
} from "./ci-gate-lib.js";
import { type Env, type Exec, realExec } from "./lib.js";

const SIGN_OFF_LINE = /^signed-off-by:\s*(\S.*?)\s+<([^<>\s]+@[^<>\s]+)>\s*$/i;

export function signOffTrailers(message: string): { name: string; email: string }[] {
  const found: { name: string; email: string }[] = [];
  for (const line of message.split("\n")) {
    const match = SIGN_OFF_LINE.exec(line);
    if (match) found.push({ name: match[1] as string, email: match[2] as string });
  }
  return found;
}

export type DcoCommit = {
  sha: string;
  message: string;
  parentCount: number;
  summary: string;
};

export type DcoCommitsParse = { ok: true; commits: DcoCommit[] } | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parsePullRequestCommits(body: unknown): DcoCommitsParse {
  if (!Array.isArray(body)) return { ok: false, reason: "the pull-request commits response is not a JSON array" };

  if (body.length >= GITHUB_API_PAGE_SIZE) {
    return {
      ok: false,
      reason:
        `the pull-request commits response fills a whole page (${body.length} commit(s), the per_page bound this rung asks for), ` +
        "so GitHub may hold more behind it. This rung reads one page, and an unsigned commit beyond it would be invisible — " +
        "refusing rather than clearing a read it cannot show to be complete. Remedy: squash the branch, then re-run.",
    };
  }

  if (body.length === 0) {
    return {
      ok: false,
      reason:
        "the pull request carries no commits — refusing rather than reading an empty list as `every commit is signed`. " +
        "A real proposal always has at least one commit, so an empty array means the read did not describe this pull request.",
    };
  }

  const commits: DcoCommit[] = [];
  for (const entry of body) {
    const item = record(entry);
    if (!item) return { ok: false, reason: "a commit entry is not a JSON object — refusing rather than skipping a commit this rung cannot read" };

    const sha = typeof item.sha === "string" && item.sha.length > 0 ? item.sha : undefined;
    if (!sha) return { ok: false, reason: "a commit entry carries no `sha` — refusing rather than judging a commit it cannot name" };

    const commit = record(item.commit);
    const message = commit && typeof commit.message === "string" ? commit.message : undefined;
    if (message === undefined) {
      return { ok: false, reason: `commit ${sha.slice(0, 12)} carries no \`commit.message\` — refusing rather than reading an unreadable record as unsigned` };
    }

    const parents = item.parents;
    if (!Array.isArray(parents)) {
      return { ok: false, reason: `commit ${sha.slice(0, 12)} carries no \`parents\` array — the merge-commit exemption turns on it, so an absent count refuses` };
    }

    commits.push({ sha, message, parentCount: parents.length, summary: (message.split("\n")[0] ?? "").trim().slice(0, 72) });
  }

  return { ok: true, commits };
}

export type DcoJudgement = {
  verdict: "pass" | "refuse";
  message: string;
  checked: number;
  exempt: number;
  unsigned: string[];
};

export function judgeDcoSignoff(commits: DcoCommit[]): DcoJudgement {
  const unsigned: string[] = [];
  let checked = 0;
  let exempt = 0;

  for (const commit of commits) {
    if (commit.parentCount > 1) {
      exempt += 1;
      continue;
    }
    checked += 1;
    if (signOffTrailers(commit.message).length === 0) unsigned.push(`${commit.sha.slice(0, 12)} ${commit.summary}`);
  }

  if (checked === 0) {
    return {
      verdict: "refuse",
      checked,
      exempt,
      unsigned,
      message:
        `every commit in this pull request is a merge commit (${exempt} of them), so the DCO rung tested NOTHING. ` +
        "It refuses rather than report `every commit is signed` about an empty set — a merge can still carry a conflict " +
        "resolution, and no one certified it. Remedy: put the change in an ordinary commit signed with `git commit -s`.",
    };
  }

  if (unsigned.length > 0) {
    return {
      verdict: "refuse",
      checked,
      exempt,
      unsigned,
      message:
        `${unsigned.length} of ${checked} commit(s) carry no \`Signed-off-by: Name <email>\` trailer, which the DCO requires ` +
        `(CONTRIBUTING.md § "Sign your commits"):\n${unsigned.map((line) => `    ${line}`).join("\n")}\n` +
        "  Remedy: `git rebase --signoff <base>` on the branch, force-push, then re-run this rung. " +
        "New commits: `git commit -s`.",
    };
  }

  return {
    verdict: "pass",
    checked,
    exempt,
    unsigned,
    message:
      `every commit carries a DCO sign-off (${checked} checked` +
      `${exempt > 0 ? `, ${exempt} merge commit(s) exempt — a merge certifies no new authored work` : ""}).`,
  };
}

export type DcoRungResult = { ok: true; judgement: DcoJudgement } | { ok: false; reason: string };

export async function runDcoRung(input: {
  prNumber: number;
  exec?: Exec;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
}): Promise<DcoRungResult> {
  const raw = await fetchGithubApi({
    ghArgs: ["api", `repos/{owner}/{repo}/pulls/${input.prNumber}/commits`, "--method", "GET", "-f", `per_page=${GITHUB_API_PAGE_SIZE}`],
    restPathSuffix: `pulls/${input.prNumber}/commits?per_page=${GITHUB_API_PAGE_SIZE}`,
    exec: input.exec ?? realExec,
    fetchImpl: input.fetchImpl ?? realGithubApiFetch,
    env: input.env ?? process.env,
  });
  if (!raw.ok) return { ok: false, reason: `could not read the commits of pull request #${input.prNumber} (${raw.reason})` };

  const parsed = parsePullRequestCommits(raw.body);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  return { ok: true, judgement: judgeDcoSignoff(parsed.commits) };
}
