import {
  parsePrivateKey,
  signAppJwt,
  mintInstallationToken,
  loadGitHubAppConfig,
  resolveGitHubInstallationId,
  type PostArm,
  type UnifiedWakeOrigin,
  type UnifiedReplyDeps,
} from "@open-everywhere/core/agent/adapter-api.js";

type GitHubOrigin = Extract<UnifiedWakeOrigin, { platform: "github" }>;

const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

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
    throw new Error("unified reply couldn't post to GitHub — no App credentials (set OE_GITHUB_APP_* or GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY).");
  }
  const installationId = origin.installationId !== undefined ? String(origin.installationId) : await resolveGitHubInstallationId(origin.owner, creds.installations);
  if (!installationId) {
    throw new Error(
      `unified reply couldn't post to GitHub — no installation id for owner "${origin.owner}" (the wake carried none, OE_GITHUB_INSTALLATIONS has no entry, and no installation webhook has registered one).`,
    );
  }
  const cacheKey = `${installationId} ${origin.repo}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - 5 * 60_000 > Date.now()) return cached.token;
  const jwt = await signAppJwt(parsePrivateKey(creds.privateKeyPem), creds.appId, Math.floor(Date.now() / 1000));
  const minted = await mintInstallationToken({ jwt, installationId, repoNames: [origin.repo], permissions: { issues: "write" } });
  tokenCache.set(cacheKey, { token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) });
  return minted.token;
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
    throw new Error(`unified reply couldn't post to GitHub — ${res.status} on ${origin.owner}/${origin.repo}#${origin.issueNumber}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: number };
  return json.id !== undefined ? String(json.id) : "unknown";
}

export const githubPostArm: PostArm = {
  platform: "github",
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
