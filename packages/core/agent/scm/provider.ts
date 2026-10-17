import { loadGitHubAppConfig } from "./config.js";
import { getSettings } from "../settings/settings.js";
import { GitHubApp } from "./app.js";
import {
  discoveredGitHubInstallations,
  discoveredInstallationsGeneration,
  hydrateGitHubInstallations,
} from "./installations.js";

let cached: GitHubApp | null | undefined;
let cachedGeneration = -1;

export function getGitHubApp(): GitHubApp | null {
  if (getSettings().github.auth === "token") return null;
  const generation = discoveredInstallationsGeneration();
  if (cached !== undefined && cachedGeneration === generation) return cached;
  const config = loadGitHubAppConfig();
  cached = config
    ? new GitHubApp(config, {
        discovered: (owner) => discoveredGitHubInstallations()[owner],
        hydrate: () => hydrateGitHubInstallations(),
      })
    : null;
  cachedGeneration = generation;
  return cached;
}

export function resetGitHubApp(): void {
  cached = undefined;
  cachedGeneration = -1;
}

export function repoAllowed(repo: string, granted: readonly string[]): boolean {
  return granted.includes(repo);
}
