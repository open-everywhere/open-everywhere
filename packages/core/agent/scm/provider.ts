import { loadGitHubAppConfig } from "./config.js";
import { GitHubApp } from "./app.js";

let cached: GitHubApp | null | undefined;

export function getGitHubApp(): GitHubApp | null {
  if (cached !== undefined) return cached;
  const config = loadGitHubAppConfig();
  cached = config ? new GitHubApp(config) : null;
  return cached;
}

export function resetGitHubApp(): void {
  cached = undefined;
}

export function repoAllowed(repo: string, granted: readonly string[]): boolean {
  return granted.includes(repo);
}
