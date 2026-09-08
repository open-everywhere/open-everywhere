import {
  parsePrivateKey,
  signAppJwt,
  mintInstallationToken,
  CONVERSATION_WRITE_PERMISSIONS,
  loadGitHubAppConfig,
  resolveGitHubInstallationId,
  warmCredential,
  markNotApplied,
  withRetryAfter,
  type RateLimitRetryOptions,
  type BrokeredSecret,
  type PostArm,
  type ReplyTarget,
  type ReactTarget,
  type TargetResolveBag,
  type UnifiedWakeOrigin,
  type UnifiedReplyDeps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { markGitHubConversationPosted } from "./github-reaction-scope.js";

type GitHubOrigin = Extract<UnifiedWakeOrigin, { platform: "github" }>;
type GitHubReactTarget = Extract<ReactTarget, { platform: "github" }>;

interface GitHubMintContext {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly installationId: string;
  readonly owner: string;
  readonly repo: string;
}

const installationToken = warmCredential<GitHubMintContext>({
  name: "github.installation-token",
  platform: "github",
  auditAction: "github.token_mint_failed",
  refresh: "re-mint",
  fallbackTtlSeconds: 3600,
  key: (ctx) => `${ctx.installationId} ${ctx.repo}`,
  mint: async (ctx): Promise<BrokeredSecret> => {
    const jwt = await signAppJwt(parsePrivateKey(ctx.privateKeyPem), ctx.appId, Math.floor(Date.now() / 1000));
    const minted = await mintInstallationToken({ jwt, installationId: ctx.installationId, repoNames: [ctx.repo], permissions: CONVERSATION_WRITE_PERMISSIONS });
    const expected = `${ctx.owner}/${ctx.repo}`;
    if (!minted.repositories.includes(expected)) {
      throw new Error(
        `installation token for "${ctx.installationId}" does not cover "${expected}" — granted: [${minted.repositories.join(", ") || "none"}].`,
      );
    }
    const parsed = Date.parse(minted.expiresAt);
    return { value: minted.token, expiresAtMs: Number.isFinite(parsed) ? parsed : undefined };
  },
});

export function _resetGitHubInstallationTokenCache(): void {
  installationToken.reset();
}

function githubAppCreds(): { appId: string; privateKeyPem: string; installations: Record<string, string> } | null {
  const scm = loadGitHubAppConfig();
  if (scm) return { appId: scm.clientId ?? scm.appId, privateKeyPem: scm.privateKeyPem, installations: scm.installations };
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKeyPem) return null;
  return { appId, privateKeyPem, installations: {} };
}

export async function installationTokenFor(origin: GitHubOrigin): Promise<string> {
  const creds = githubAppCreds();
  if (!creds) {
    throw markNotApplied(new Error("reply couldn't post to GitHub — no App credentials (set OE_GITHUB_APP_* or GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY)."));
  }
  const installationId = origin.installationId !== undefined ? String(origin.installationId) : await resolveGitHubInstallationId(origin.owner, creds.installations);
  if (!installationId) {
    throw markNotApplied(new Error(
      `reply couldn't post to GitHub — no installation id for owner "${origin.owner}" (the wake carried none, OE_GITHUB_INSTALLATIONS has no entry, and no installation webhook has registered one).`,
    ));
  }
  return installationToken.get({ appId: creds.appId, privateKeyPem: creds.privateKeyPem, installationId, owner: origin.owner, repo: origin.repo });
}

export const GITHUB_API_BASE = "https://api.github.com";

export type GitHubFetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GitHubWriteDeps {
  readonly fetch?: GitHubFetchLike;
  readonly retry?: Pick<RateLimitRetryOptions, "maxAttempts" | "capMs" | "fallbackMs" | "totalBudgetMs" | "sleep" | "now">;
}

export async function githubWrite(
  input: {
    readonly operation: string;
    readonly method: "POST" | "PATCH";
    readonly path: string;
    readonly token: string;
    readonly body: unknown;
  },
  deps: GitHubWriteDeps = {},
): Promise<Response> {
  const send = (): Promise<Response> =>
    (deps.fetch ?? (globalThis.fetch as GitHubFetchLike))(`${GITHUB_API_BASE}${input.path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    });
  return withRetryAfter(send, { ...deps.retry, surface: "github", operation: input.operation, retryForbiddenWithRetryAfter: true });
}

export async function liveGitHubPost(origin: GitHubOrigin, text: string): Promise<string> {
  const token = await installationTokenFor(origin);
  const res = await githubWrite({
    operation: "issues.createComment",
    method: "POST",
    path: `/repos/${origin.owner}/${origin.repo}/issues/${origin.issueNumber}/comments`,
    token,
    body: { body: text },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`reply couldn't post to GitHub — ${res.status} on ${origin.owner}/${origin.repo}#${origin.issueNumber}`), { status: res.status });
  }
  const json = (await res.json().catch(() => ({}))) as { id?: number };
  await markGitHubConversationPosted(origin.owner, origin.repo, origin.issueNumber, new Date().toISOString());
  return json.id !== undefined ? String(json.id) : "unknown";
}

type GitHubReplyTarget = Extract<ReplyTarget, { platform: "github" }>;

function originForTarget(target: GitHubReplyTarget): GitHubOrigin {
  return {
    platform: "github",
    owner: target.owner,
    repo: target.repo,
    issueNumber: target.issueNumber,
    ...(target.installationId !== undefined ? { installationId: target.installationId } : {}),
  };
}

export async function liveGitHubEditComment(channelId: string, commentId: string, text: string): Promise<void> {
  const [owner, repo] = channelId.split("/");
  if (!owner || !repo) {
    throw markNotApplied(new Error(`edit_reply couldn't parse the GitHub locus "${channelId}" — expected "owner/repo".`));
  }
  const token = await installationTokenFor({ platform: "github", owner, repo, issueNumber: 0 });
  const res = await githubWrite({
    operation: "issues.updateComment",
    method: "PATCH",
    path: `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    token,
    body: { body: text },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`edit_reply couldn't edit the GitHub comment — ${res.status} on ${owner}/${repo} comment ${commentId}`), { status: res.status });
  }
}

type GitHubReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

const GITHUB_REACTION_MAP: Readonly<Record<string, GitHubReactionContent>> = {
  "+1": "+1",
  thumbsup: "+1",
  "-1": "-1",
  thumbsdown: "-1",
  laugh: "laugh",
  laughing: "laugh",
  joy: "laugh",
  confused: "confused",
  heart: "heart",
  hooray: "hooray",
  tada: "hooray",
  rocket: "rocket",
  eyes: "eyes",
};

async function liveGitHubReact(origin: GitHubOrigin, emoji: string): Promise<void> {
  const content = GITHUB_REACTION_MAP[emoji.toLowerCase()];
  if (!content) {
    throw markNotApplied(
      new Error(
        `react couldn't post to GitHub — "${emoji}" has no GitHub reaction equivalent; GitHub only supports: ${[...new Set(Object.values(GITHUB_REACTION_MAP))].join(", ")}.`,
      ),
    );
  }
  const token = await installationTokenFor(origin);
  const res = await githubWrite({
    operation: "issues.createReaction",
    method: "POST",
    path: `/repos/${origin.owner}/${origin.repo}/issues/${origin.issueNumber}/reactions`,
    token,
    body: { content },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`react couldn't post to GitHub — ${res.status} on ${origin.owner}/${origin.repo}#${origin.issueNumber}`), { status: res.status });
  }
}

export const githubPostArm: PostArm = {
  platform: "github",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const owner = bag.str("owner");
    const repo = bag.str("repo");
    const issueNumber = bag.num("issueNumber") ?? bag.num("pullRequestNumber");
    if (!owner || !repo || issueNumber === undefined || !Number.isFinite(issueNumber) || issueNumber <= 0) return null;
    const installationId = bag.num("installationId");
    return { platform: "github", owner, repo, issueNumber, ...(installationId !== undefined ? { installationId } : {}) };
  },
  dispatchReply: (target, text) => liveGitHubPost(originForTarget(target as GitHubReplyTarget), text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postGitHub ?? liveGitHubPost)(origin as GitHubOrigin, text),
  editMessage: (locus, messageId, text) => liveGitHubEditComment(locus.channelId, messageId, text),
  resolveReactTarget: (bag: TargetResolveBag): ReactTarget | null => {
    const owner = bag.str("owner");
    const repo = bag.str("repo");
    const issueNumber = bag.num("issueNumber") ?? bag.num("pullRequestNumber");
    if (!owner || !repo || issueNumber === undefined || !Number.isFinite(issueNumber) || issueNumber <= 0) return null;
    const installationId = bag.num("installationId");
    return { platform: "github", owner, repo, issueNumber, ...(installationId !== undefined ? { installationId } : {}) };
  },
  react: (target, emoji) => {
    const t = target as GitHubReactTarget;
    return liveGitHubReact(
      { platform: "github", owner: t.owner, repo: t.repo, issueNumber: t.issueNumber, ...(t.installationId !== undefined ? { installationId: t.installationId } : {}) },
      emoji,
    );
  },
  describeRedriveTarget: (origin) => {
    const o = origin as GitHubOrigin;
    return `github ${o.owner}/${o.repo}#${o.issueNumber}`;
  },
  redriveContainerId: (origin) => {
    const o = origin as GitHubOrigin;
    return `${o.owner}/${o.repo}`;
  },
};
