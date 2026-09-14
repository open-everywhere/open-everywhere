import { getGitHubApp } from "./provider.js";
import { DEFAULT_PERMISSIONS, expandMintPermissions } from "./mint.js";
import type { RepoCapability } from "../access/repo-capabilities.js";

export async function resolvePrWriteToken(repo: string, capabilities: readonly RepoCapability[], subject = ""): Promise<string> {
  const app = getGitHubApp();
  if (app) {
    const { tokens, ungranted } = await app.tokensForRepos([repo], expandMintPermissions(DEFAULT_PERMISSIONS, capabilities));
    if (!ungranted.length) return tokens.get(repo.slice(0, repo.indexOf("/")))!.token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (!pat) {
    throw new Error(`no GitHub credential${subject ? ` for ${subject}` : ""}: configure the GitHub App (OE_GITHUB_APP_*) or set GITHUB_TOKEN.`);
  }
  return pat;
}
