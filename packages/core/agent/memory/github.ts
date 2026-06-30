import type { Partition } from "./partition.js";
import type { MemorySilo } from "./silo.js";
import type { MemoryProvider } from "./provider.js";
import { registerProvider } from "./provider.js";
import { type MemoryFiles, type Tier } from "./store.js";
import { tierRelDir, safeName, seedFor } from "./layout.js";
import { makeSelector, normalizeSelection } from "./selection.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { getGitHubApp } from "../scm/provider.js";

const DEFAULT_BRANCH = process.env.OE_MEMORY_GIT_BRANCH || "main";

export interface GitHubMemoryDeps {
  readonly contents: GitHubContents;
  mintToken(repo: string): Promise<string>;
  committer(): CommitId;
  readonly branch?: string;
}

function requireSilo(silo: MemorySilo | undefined): MemorySilo {
  if (!silo?.container) {
    throw new Error('github memory backing needs a silo with container "owner/repo" (memory/silo.ts).');
  }
  return silo;
}

function repoPath(silo: MemorySilo, p: Partition, tier: Tier): string {
  return [silo.path, safeName(p.org), tierRelDir(p, tier)].filter((s) => s && s.length > 0).join("/");
}

export function makeGitHubProvider(deps: GitHubMemoryDeps): MemoryProvider {
  const branch = deps.branch ?? DEFAULT_BRANCH;

  async function read(p: Partition, tier: Tier, siloArg?: MemorySilo): Promise<MemoryFiles> {
    const silo = requireSilo(siloArg);
    const repo = silo.container!;
    const dir = repoPath(silo, p, tier);
    const token = await deps.mintToken(repo);
    const shas = await deps.contents.listFiles(repo, dir, branch, token, makeSelector(normalizeSelection(silo)));
    const out: MemoryFiles = {};
    for (const rel of Object.keys(shas)) {
      const file = await deps.contents.getFile(repo, `${dir}/${rel}`, branch, token);
      if (file) out[rel] = file.content;
    }
    return out;
  }

  async function write(p: Partition, tier: Tier, files: MemoryFiles, message: string, siloArg?: MemorySilo): Promise<string | null> {
    const silo = requireSilo(siloArg);
    const repo = silo.container!;
    const dir = repoPath(silo, p, tier);
    const token = await deps.mintToken(repo);
    const committer = deps.committer();
    let last: string | null = null;
    let changed = false;
    for (const [rel, content] of Object.entries(files)) {
      const path = `${dir}/${rel}`;
      const existing = await deps.contents.getFile(repo, path, branch, token);
      if (existing && existing.content === content) continue;
      changed = true;
      last = await deps.contents.putFile(repo, path, content, message, branch, token, committer, existing?.sha);
    }
    return changed ? last : null;
  }

  return {
    id: "github",
    readTier: read,
    ensureTier: async (p, tier, siloArg) => {
      const existing = await read(p, tier, siloArg);
      if (Object.keys(existing).length > 0) return existing;
      const seed = seedFor(p, tier);
      await write(p, tier, seed, `seed ${tier.kind} memory`, siloArg);
      return seed;
    },
    writeTier: write,
    deleteTier: async (p, tier, siloArg) => {
      const silo = requireSilo(siloArg);
      const repo = silo.container!;
      const dir = repoPath(silo, p, tier);
      const token = await deps.mintToken(repo);
      const committer = deps.committer();
      const shas = await deps.contents.listFiles(repo, dir, branch, token, makeSelector(normalizeSelection(silo)));
      for (const [rel, sha] of Object.entries(shas)) {
        await deps.contents.deleteFile(repo, `${dir}/${rel}`, sha, `delete ${tier.kind} memory`, branch, token, committer);
      }
    },
  };
}

interface CachedToken {
  token: string;
  expiresMs: number;
}

export function registerGitHubMemory(): boolean {
  const app = getGitHubApp();
  if (!app) return false;
  const cache = new Map<string, CachedToken>();
  const provider = makeGitHubProvider({
    contents: new GitHubContents(),
    committer: () => app.committer(),
    async mintToken(repo: string): Promise<string> {
      const hit = cache.get(repo);
      if (hit && hit.expiresMs > Date.now() + 60_000) return hit.token;
      const out = await app.tokensForRepos([repo]);
      const owner = repo.slice(0, repo.indexOf("/"));
      const minted = out.tokens.get(owner);
      if (!minted) {
        throw new Error(`memory repo "${repo}" has no linked GitHub App installation (scm config).`);
      }
      cache.set(repo, { token: minted.token, expiresMs: Date.parse(minted.expiresAt) });
      return minted.token;
    },
  });
  registerProvider(provider);
  return true;
}
