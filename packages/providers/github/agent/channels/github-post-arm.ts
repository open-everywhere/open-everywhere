import {
  parsePrivateKey,
  signAppJwt,
  mintInstallationToken,
  loadGitHubAppConfig,
  resolveGitHubInstallationId,
  warmCredential,
  markNotApplied,
  type BrokeredSecret,
  type PostArm,
  type ReplyTarget,
  type TargetResolveBag,
  type UnifiedWakeOrigin,
  type UnifiedReplyDeps,
} from "@open-everywhere/core/agent/adapter-api.js";

type GitHubOrigin = Extract<UnifiedWakeOrigin, { platform: "github" }>;

interface GitHubMintContext {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly installationId: string;
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
    const minted = await mintInstallationToken({ jwt, installationId: ctx.installationId, repoNames: [ctx.repo], permissions: { issues: "write" } });
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

async function installationTokenFor(origin: GitHubOrigin): Promise<string> {
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
  return installationToken.get({ appId: creds.appId, privateKeyPem: creds.privateKeyPem, installationId, repo: origin.repo });
}

async function liveGitHubPost(origin: GitHubOrigin, text: string): Promise<string> {
  const token = await installationTokenFor(origin);
  const res = await fetch(`https://api.github.com/repos/${origin.owner}/${origin.repo}/issues/${origin.issueNumber}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: text }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`reply couldn't post to GitHub — ${res.status} on ${origin.owner}/${origin.repo}#${origin.issueNumber}`), { status: res.status });
  }
  const json = (await res.json().catch(() => ({}))) as { id?: number };
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
  describeRedriveTarget: (origin) => {
    const o = origin as GitHubOrigin;
    return `github ${o.owner}/${o.repo}#${o.issueNumber}`;
  },
  redriveContainerId: (origin) => {
    const o = origin as GitHubOrigin;
    return `${o.owner}/${o.repo}`;
  },
};
