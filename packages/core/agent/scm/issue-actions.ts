import { getGitHubApp, repoAllowed } from "./provider.js";
import { resolveAccessFor } from "../access/request.js";
import { ISSUE_WRITE_PERMISSIONS, expandMintPermissions } from "./mint.js";
import type { RepoCapability } from "../access/repo-capabilities.js";
import { prApiHeaders, type PrFetchFn } from "./pr.js";
import { currentTurnGithubTarget, type BindableContext } from "../identity/binding.js";
import type { EntityActionAdapter } from "../channels/entity-actions.js";
import type { CreatedTicket, TicketCreateAdapter, TicketDraft } from "../channels/ticket-create.js";
import { withRetryAfterLoose, type RetryPolicy } from "../channels/rate-limit-retry.js";

export function parseGithubEntityId(id: string): { repo: string; number: number } {
  const m = /^([^/#]+\/[^/#]+)#(\d+)$/.exec(id);
  if (!m) throw new Error(`invalid GitHub entity id "${id}" — expected "owner/repo#123".`);
  return { repo: m[1], number: Number(m[2]) };
}

async function resolveIssueWriteToken(
  repo: string,
  app = getGitHubApp(),
  capabilities: readonly RepoCapability[] = [],
): Promise<string> {
  if (app) {
    const { tokens, ungranted } = await app.tokensForRepos([repo], expandMintPermissions(ISSUE_WRITE_PERMISSIONS, capabilities));
    if (!ungranted.length) return tokens.get(repo.slice(0, repo.indexOf("/")))!.token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (!pat) {
    throw new Error("no GitHub credential: configure the GitHub App (OE_GITHUB_APP_*) or set GITHUB_TOKEN.");
  }
  return pat;
}

export interface GithubActionOpts {
  readonly fetchFn?: PrFetchFn;
  readonly apiBase?: string;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly capabilities?: readonly RepoCapability[];
  readonly retry?: RetryPolicy;
}

async function callIssueApi(
  repo: string,
  number: number,
  operation: string,
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
  opts: GithubActionOpts,
): Promise<void> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const token = await (opts.resolveToken ?? ((r: string) => resolveIssueWriteToken(r, getGitHubApp(), opts.capabilities ?? [])))(repo);
  const res = await withRetryAfterLoose(() => fetchFn(`${apiBase}${path}`, { method, headers: prApiHeaders(token), body: JSON.stringify(body) }), {
    ...opts.retry,
    surface: "github",
    operation,
  });
  if (!res.ok) {
    throw new Error(`GitHub issue action failed for ${repo}#${number}: ${res.status} ${await res.text()}`);
  }
}

export async function setGithubIssueState(entityId: string, state: string, opts: GithubActionOpts = {}): Promise<string> {
  const { repo, number } = parseGithubEntityId(entityId);
  const normalized = state.trim().toLowerCase();
  if (normalized !== "open" && normalized !== "closed") {
    throw new Error(`GitHub: state must be "open" or "closed" (got "${state}").`);
  }
  await callIssueApi(repo, number, "issues.update", `/repos/${repo}/issues/${number}`, "PATCH", { state: normalized }, opts);
  return `GitHub ${repo}#${number} state set to "${normalized}".`;
}

export async function assignGithubIssue(entityId: string, assignee: string, opts: GithubActionOpts = {}): Promise<string> {
  const { repo, number } = parseGithubEntityId(entityId);
  await callIssueApi(repo, number, "issues.assignees.add", `/repos/${repo}/issues/${number}/assignees`, "POST", { assignees: [assignee] }, opts);
  return `GitHub ${repo}#${number} assigned to ${assignee}.`;
}

export async function addGithubIssueLabel(entityId: string, label: string, opts: GithubActionOpts = {}): Promise<string> {
  const { repo, number } = parseGithubEntityId(entityId);
  await callIssueApi(repo, number, "issues.labels.add", `/repos/${repo}/issues/${number}/labels`, "POST", { labels: [label] }, opts);
  return `Label "${label}" added to GitHub ${repo}#${number}.`;
}

function requireRepoGrant(ctx: BindableContext, repo: string): void {
  const access = resolveAccessFor(ctx);
  if (!repoAllowed(repo, access.repos)) {
    throw new Error(
      `repo "${repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
        `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
    );
  }
}

function checkGithubAccess(ctx: BindableContext, entityId: string): void {
  requireRepoGrant(ctx, parseGithubEntityId(entityId).repo);
}

function githubCapabilitiesFor(ctx: BindableContext, entityId: string): readonly RepoCapability[] {
  const { repo } = parseGithubEntityId(entityId);
  return resolveAccessFor(ctx).repoCapabilities[repo] ?? [];
}

export const githubEntityAdapter: EntityActionAdapter = {
  platform: "github",
  checkAccess: checkGithubAccess,
  capabilitiesFor: githubCapabilitiesFor,
  setState: (id, value, _organizationId, capabilities) => setGithubIssueState(id, value, { capabilities: capabilities ?? [] }),
  assign: (id, value, _organizationId, capabilities) => assignGithubIssue(id, value, { capabilities: capabilities ?? [] }),
  addLabel: (id, value, _organizationId, capabilities) => addGithubIssueLabel(id, value, { capabilities: capabilities ?? [] }),
};

interface CreatedIssueResponse {
  number?: number;
  html_url?: string;
}

export async function createGithubIssue(repo: string, draft: TicketDraft, opts: GithubActionOpts = {}): Promise<CreatedTicket> {
  if (!/^[^/#\s]+\/[^/#\s]+$/.test(repo)) {
    throw new Error(`GitHub: invalid repo "${repo}" — expected "owner/repo".`);
  }
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const token = await (opts.resolveToken ?? ((r: string) => resolveIssueWriteToken(r, getGitHubApp(), opts.capabilities ?? [])))(repo);
  const res = await withRetryAfterLoose(
    () =>
      fetchFn(`${apiBase}/repos/${repo}/issues`, {
        method: "POST",
        headers: prApiHeaders(token),
        body: JSON.stringify({ title: draft.title, body: draft.body }),
      }),
    { ...opts.retry, surface: "github", operation: "issues.create" },
  );
  if (!res.ok) {
    throw new Error(`GitHub issue creation failed for ${repo}: ${res.status} ${await res.text()}`);
  }
  const created = (await res.json()) as CreatedIssueResponse;
  if (typeof created.number !== "number") {
    throw new Error(`GitHub: issue creation on ${repo} returned no issue number — unexpected API response.`);
  }
  const id = `${repo}#${created.number}`;
  return {
    ref: { platform: "github", id },
    ...(typeof created.html_url === "string" ? { url: created.html_url } : {}),
    summary: `Filed GitHub issue ${id}: "${draft.title}".`,
  };
}

function defaultGithubRepo(ctx: BindableContext): string | undefined {
  const t = currentTurnGithubTarget(ctx);
  if (t) return `${t.owner}/${t.repo}`;
  const repos = resolveAccessFor(ctx).repos.filter((r) => !r.includes("*"));
  return repos.length === 1 ? repos[0] : undefined;
}

export const githubTicketCreateAdapter: TicketCreateAdapter = {
  platform: "github",
  checkAccess: (ctx, target) => requireRepoGrant(ctx, target),
  defaultTarget: defaultGithubRepo,
  create: (target, draft) => createGithubIssue(target, draft),
};
