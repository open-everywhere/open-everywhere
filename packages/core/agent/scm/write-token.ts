import { resolveRepoToken } from "./credential.js";
import { DEFAULT_PERMISSIONS, expandMintPermissions } from "./mint.js";
import type { RepoCapability } from "../access/repo-capabilities.js";

export async function resolvePrWriteToken(repo: string, capabilities: readonly RepoCapability[], subject = ""): Promise<string> {
  return resolveRepoToken(repo, expandMintPermissions(DEFAULT_PERMISSIONS, capabilities), { subject });
}
