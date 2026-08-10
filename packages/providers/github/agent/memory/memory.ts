import { createHash } from "node:crypto";
import {
  type MemoryProvider,
  type MemorySilo,
  type MemoryFiles,
  type Partition,
  type Tier,
  type DomainMemoryGrants,
  registerProvider,
  registerConnectorMemory,
  tierRelDir,
  safeName,
  seedFor,
  makeSelector,
  normalizeSelection,
  GitHubContents,
  type CommitId,
  getGitHubApp,
  warmCredential,
} from "@open-everywhere/core/agent/adapter-api.js";

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
    tierVersion: async (p, tier, siloArg) => {
      const silo = requireSilo(siloArg);
      const repo = silo.container!;
      const dir = repoPath(silo, p, tier);
      const token = await deps.mintToken(repo);
      const shas = await deps.contents.listFiles(repo, dir, branch, token, makeSelector(normalizeSelection(silo)));
      const entries = Object.entries(shas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (entries.length === 0) return null;
      const h = createHash("sha1");
      for (const [rel, sha] of entries) h.update(`${rel}\n${sha}\n`);
      return h.digest("hex");
    },
    deleteFile: async (p, tier, relPath, siloArg) => {
      const silo = requireSilo(siloArg);
      const repo = silo.container!;
      const path = `${repoPath(silo, p, tier)}/${relPath}`;
      const token = await deps.mintToken(repo);
      const existing = await deps.contents.getFile(repo, path, branch, token);
      if (!existing) return null;
      const committer = deps.committer();
      return deps.contents.deleteFile(repo, path, existing.sha, `delete ${relPath} from ${tier.kind} memory`, branch, token, committer);
    },
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

export function githubMemoryContainerProblem(silo: MemorySilo, grants: DomainMemoryGrants): string | null {
  const repo = silo.container;
  if (typeof repo !== "string" || repo.length === 0) {
    return `github-backed silos need container = "owner/repo" (memory/silo.ts)`;
  }
  if (grants.repos.includes(repo)) return null;
  return (
    `container "${repo}" is NOT in this domain's granted repos [${grants.repos.join(", ") || "none"}] — ` +
    `a memory projection is read access, and the scm tools already refuse an ungranted repo fail-closed, so ` +
    `add "${repo}" to a bundle bound to this domain (bundle.repos) or point the silo at a granted repo.`
  );
}

export function registerGitHubMemory(): boolean {
  const app = getGitHubApp();
  if (!app) return false;
  const memoryToken = warmCredential<string>({
    name: "github.memory-installation-token",
    platform: "github",
    auditAction: "github.token_mint_failed",
    refresh: "re-mint",
    refreshMarginMs: 60_000,
    fallbackTtlSeconds: 3600,
    key: (repo) => repo,
    mint: async (repo) => {
      const out = await app.tokensForRepos([repo]);
      const owner = repo.slice(0, repo.indexOf("/"));
      const minted = out.tokens.get(owner);
      if (!minted) {
        throw new Error(`memory repo "${repo}" has no linked GitHub App installation (scm config).`);
      }
      const parsed = Date.parse(minted.expiresAt);
      return { value: minted.token, expiresAtMs: Number.isFinite(parsed) ? parsed : undefined };
    },
  });
  const provider = makeGitHubProvider({
    contents: new GitHubContents(),
    committer: () => app.committer(),
    mintToken: (repo: string) => memoryToken.get(repo),
  });
  registerProvider(provider);
  declareGitHubMemoryCapability();
  return true;
}

export function declareGitHubMemoryCapability(): void {
  registerConnectorMemory({
    provider: "github",
    connector: "github",
    mode: "read-write",
    subject: "app-principal",
    containerLabel: 'a repo, "owner/repo"',
    assertContainerGranted: githubMemoryContainerProblem,
  });
}
