import { getSettings, type GithubAuthMode } from "../settings/settings.js";
import { operatorSecret } from "../credentials/operator-secrets.js";
import { getConfig } from "../access/config.js";
import { getGitHubApp } from "./provider.js";
import type { GitHubApp } from "./app.js";
import type { MintPermissions } from "./types.js";

export function githubAuthMode(): GithubAuthMode {
  return getSettings().github.auth;
}

const GITHUB_TOKEN_NAME = "GITHUB_TOKEN";

export async function githubTokenSet(): Promise<boolean> {
  try {
    return (await personalTokenValue()) !== undefined;
  } catch {
    return false;
  }
}

export async function personalTokenValue(): Promise<string | undefined> {
  const token = await operatorSecret(GITHUB_TOKEN_NAME);
  return token ? token : undefined;
}

export async function githubCredentialConfigured(): Promise<boolean> {
  return githubAuthMode() === "token" ? await githubTokenSet() : getGitHubApp() !== null;
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

export async function personalTokenFor(repo: string, subject = ""): Promise<string> {
  const token = await personalTokenValue();
  if (!token) {
    throw new Error(
      `no GitHub credential${forWords(subject)}: this deployment signs in to GitHub with a personal access token (github.auth "token"), and GITHUB_TOKEN is not set.`,
    );
  }
  if (!tokenReaches(repo)) {
    const reach = tokenRepos();
    throw new Error(
      `the personal access token does not reach ${repo}. It reaches ${reach.length > 0 ? reach.join(", ") : "no repository yet (accessRequests.configRepo is not set)"}: ` +
        `the deployment's own repository and github.tokenRepos in agent/settings/settings.ts. Add the repository there, or move to the GitHub App.`,
    );
  }
  return token;
}

export async function appMissingError(subject = ""): Promise<Error> {
  const unused = (await githubTokenSet())
    ? ` GITHUB_TOKEN is set, but this deployment signs in with the GitHub App (github.auth "app"), so the token is not used. To use it instead, set github.auth: "token" in agent/settings/settings.ts.`
    : "";
  return new Error(`no GitHub credential${forWords(subject)}: configure the GitHub App (the github.appId and github.appSlug settings, and the operator secret GITHUB_APP_PRIVATE_KEY: oe secret set GITHUB_APP_PRIVATE_KEY).${unused}`);
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
  if (githubAuthMode() === "token") return await personalTokenFor(repo, subject);
  const app = opts.app === undefined ? getGitHubApp() : opts.app;
  if (!app) throw await appMissingError(subject);
  const { tokens, ungranted } = await app.tokensForRepos([repo], permissions);
  const token = ungranted.length ? undefined : tokens.get(repo.slice(0, repo.indexOf("/")))?.token;
  if (token === undefined) throw appNotInstalledError(repo, subject);
  return token;
}

export function githubCommitter(): { name: string; email: string } {
  return getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
}
