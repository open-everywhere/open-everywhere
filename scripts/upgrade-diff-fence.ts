import { readFileSync } from "node:fs";
import { formatUpgradeFenceReport, judgeUpgradeDiff } from "./upgrade-fence/judge.js";
import { listPullRequestFiles } from "./upgrade-fence/pr-files.js";

interface PullRequestEvent {
  readonly pull_request?: {
    readonly number?: number;
    readonly title?: string;
    readonly body?: string | null;
    readonly user?: { readonly login?: string; readonly type?: string };
  };
}

function fail(message: string): never {
  console.error(`✗ upgrade-diff-fence: ${message}`);
  process.exit(1);
}

const eventPath = process.env.GITHUB_EVENT_PATH;
const eventName = process.env.GITHUB_EVENT_NAME;
if (eventName && eventName !== "pull_request" && eventName !== "pull_request_target") {
  console.log(`upgrade-diff-fence: event "${eventName}" is not a pull request — nothing to fence.`);
  process.exit(0);
}
if (!eventPath) fail("GITHUB_EVENT_PATH is not set — this script runs inside a GitHub Actions pull-request job.");

let event: PullRequestEvent;
try {
  event = JSON.parse(readFileSync(eventPath, "utf8")) as PullRequestEvent;
} catch (err) {
  fail(`could not read the event payload at ${eventPath}: ${(err as Error).message}`);
}

const pr = event.pull_request;
if (!pr || typeof pr.number !== "number") fail("the event payload carries no pull_request.number");

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) fail("GITHUB_REPOSITORY is not set");
const token = process.env.GITHUB_TOKEN;
if (!token) fail("GITHUB_TOKEN is not set — the fence needs `pull-requests: read` to list the changed files");

const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";

const changedFiles = await listPullRequestFiles({ repo, number: pr.number, token, apiBase }).catch((err: Error) =>
  fail(`could not list the pull request's files: ${err.message}`),
);

const result = judgeUpgradeDiff({
  changedFiles,
  authorType: pr.user?.type ?? "",
  authorLogin: pr.user?.login ?? "",
  title: pr.title ?? "",
  body: pr.body ?? "",
});

for (const line of formatUpgradeFenceReport(result, changedFiles.length)) console.log(line);

for (const hit of result.hits) {
  const level = result.verdict === "refuse" ? "error" : "warning";
  console.log(`::${level} file=${hit.file}::upgrade diff fence (${hit.rule.id}): ${hit.rule.why}`);
}

process.exit(result.verdict === "refuse" ? 1 : 0);
