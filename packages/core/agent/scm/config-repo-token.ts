import { resolvePrWriteToken } from "./write-token.js";

export async function resolveConfigRepoWriteToken(repo: string): Promise<string> {
  return resolvePrWriteToken(repo, [], "the config repo");
}
