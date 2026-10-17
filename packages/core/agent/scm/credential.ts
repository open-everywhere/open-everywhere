import { getSettings, type GithubAuthMode } from "../settings/settings.js";
import { getConfig } from "../access/config.js";
import { getGitHubApp } from "./provider.js";
import type { GitHubApp } from "./app.js";
import type { MintPermissions } from "./types.js";

export function githubAuthMode(): GithubAuthMode {
  return getSettings().github.auth;
}

export function githubTokenSet(): boolean {
  return personalTokenValue() !== undefined;
}

export function personalTokenValue(): string | undefined {
  const token = process.env.GITHUB_TOKEN;
  return token ? token : undefined;
}

export function githubCredentialConfigured(): boolean {
  return githubAuthMode() === "token" ? githubTokenSet() : getGitHubApp() !== null;
}

function ownRepo(): string | undefined {
  let repo: string | undefined;
  try {
    repo = getConfig().loadAccessRequests?.()?.configRepo?.trim();
  } catch {
    return undefined;
  }
  return repo ? repo : undefined;
}

export function tokenRepos(): readonly string[] {
  const out: string[] = [];
  for (const repo of [ownRepo(), ...getSettings().github.tokenRepos]) {
    if (repo !== undefined && !out.some((r) => sameRepo(r, repo))) out.push(repo);
  }
  return out;
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function tokenReaches(repo: string): boolean {
  return tokenRepos().some((r) => sameRepo(r, repo));
}

function forWords(subject: string): string {
  return subject ? ` for ${subject}` : "";
}

export function personalTokenFor(repo: string, subject = ""): string {
  const token = personalTokenValue();
  if (!token) {
    throw new Error(
      `no GitHub credential${forWords(subject)}: this deployment signs in to GitHub with a personal access token (github.auth "token"), and GITHUB_TOKEN is not set.`,
    );
  }
  if (!tokenReaches(repo)) {
    const reach = tokenRepos();
    throw new Error(
      `the personal access token does not reach ${repo}. It reaches ${reach.length > 0 ? reach.join(", ") : "no repository yet (OE_ACCESS_CONFIG_REPO is not set)"}: ` +
        `the deployment's own repository and github.tokenRepos in agent/settings/settings.ts. Add the repository there, or move to the GitHub App.`,
    );
  }
  return token;
}

export function appMissingError(subject = ""): Error {
  const unused = githubTokenSet()
    ? ` GITHUB_TOKEN is set, but this deployment signs in with the GitHub App (github.auth "app"), so the token is not used. To use it instead, set github.auth: "token" in agent/settings/settings.ts.`
    : "";
  return new Error(`no GitHub credential${forWords(subject)}: configure the GitHub App (OE_GITHUB_APP_*).${unused}`);
}

function appNotInstalledError(repo: string, subject = ""): Error {
  return new Error(
    `no GitHub credential${forWords(subject)}: the GitHub App is not installed on ${repo}. Install it there (see docs/capabilities/source-control.md).`,
  );
}

export async function resolveRepoToken(
  repo: string,
  permissions: MintPermissions,
  opts: { readonly app?: GitHubApp | null; readonly subject?: string } = {},
): Promise<string> {
  const subject = opts.subject ?? "";
  if (githubAuthMode() === "token") return personalTokenFor(repo, subject);
  const app = opts.app === undefined ? getGitHubApp() : opts.app;
  if (!app) throw appMissingError(subject);
  const { tokens, ungranted } = await app.tokensForRepos([repo], permissions);
  const token = ungranted.length ? undefined : tokens.get(repo.slice(0, repo.indexOf("/")))?.token;
  if (token === undefined) throw appNotInstalledError(repo, subject);
  return token;
}

export function githubCommitter(): { name: string; email: string } {
  return getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
}
