import type { SandboxNetworkPolicy } from "eve/sandbox";
import { GIT_BROKER_HOSTS, type EgressRule } from "../access/egress.js";
import type { GitHubApp } from "./app.js";
import { READ_PERMISSIONS } from "./mint.js";
import { githubAuthMode, personalTokenValue, tokenReaches } from "./credential.js";
import { getGitHubApp } from "./provider.js";

export { GIT_BROKER_HOSTS } from "../access/egress.js";

const MAX_MINT_REPOS = 500;

export function brokerAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64")}` };
}

export interface GitReadBrokerResult {
  readonly rulesByOwner: ReadonlyMap<string, EgressRule>;
  readonly ungranted: readonly string[];
}

export async function mintGitReadBroker(app: GitHubApp, repos: readonly string[]): Promise<GitReadBrokerResult> {
  const perOwnerCount = new Map<string, number>();
  for (const ref of repos) {
    const slash = ref.indexOf("/");
    if (slash <= 0) continue;
    const owner = ref.slice(0, slash);
    perOwnerCount.set(owner, (perOwnerCount.get(owner) ?? 0) + 1);
  }
  for (const [owner, count] of perOwnerCount) {
    if (count > MAX_MINT_REPOS) {
      throw new Error(
        `owner "${owner}" has ${count} repos granted to this session — GitHub caps a single installation ` +
          `token mint at ${MAX_MINT_REPOS} repositories. Narrow the grant (split it across more bundles/scopes) ` +
          `rather than widen this cap.`,
      );
    }
  }

  const { tokens, ungranted } = await app.tokensForRepos(repos, READ_PERMISSIONS);
  const rulesByOwner = new Map<string, EgressRule>();
  for (const [owner, tok] of tokens) {
    rulesByOwner.set(owner, {
      match: { path: { startsWith: `/${owner}/` } },
      transform: [{ headers: brokerAuthHeader(tok.token) }],
    });
  }
  return { rulesByOwner, ungranted };
}

export function mergeGitReadBroker(
  base: SandboxNetworkPolicy,
  rulesByOwner: ReadonlyMap<string, EgressRule>,
): SandboxNetworkPolicy {
  return mergeGitBrokerRules(base, [...rulesByOwner.values()]);
}

export function mergeGitBrokerRules(base: SandboxNetworkPolicy, rules: readonly EgressRule[]): SandboxNetworkPolicy {
  if (rules.length === 0) return base;
  const allow: Record<string, EgressRule[]> = typeof base === "string" ? {} : { ...(base.allow as Record<string, EgressRule[]>) };
  for (const host of GIT_BROKER_HOSTS) allow[host] = [...rules];
  return { allow };
}

export function tokenGitReadRules(token: string, repos: readonly string[]): EgressRule[] {
  const headers = brokerAuthHeader(token);
  const rules: EgressRule[] = [];
  for (const repo of repos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) continue;
    const escaped = repo.replace(/\./gu, "\\.");
    rules.push(
      {
        match: {
          method: ["GET"],
          path: { regex: `^/${escaped}\\.git/info/refs(\\?service=git-upload-pack)?$` },
          queryString: [{ key: { exact: "service" }, value: { exact: "git-upload-pack" } }],
        },
        transform: [{ headers }],
      },
      { match: { method: ["POST"], path: { exact: `/${repo}.git/git-upload-pack` } }, transform: [{ headers }] },
    );
  }
  return rules;
}

export interface SessionGitBroker {
  readonly rules: readonly EgressRule[];
  readonly covers: (repo: string) => boolean;
}

export async function sessionGitBroker(repos: readonly string[]): Promise<SessionGitBroker | null> {
  if (githubAuthMode() === "token") {
    const token = await personalTokenValue();
    if (token === undefined) return null;
    const reached = repos.filter((r) => tokenReaches(r));
    return { rules: tokenGitReadRules(token, reached), covers: (repo) => reached.includes(repo) };
  }
  const app = getGitHubApp();
  if (!app) return null;
  const { rulesByOwner } = await mintGitReadBroker(app, repos);
  return { rules: [...rulesByOwner.values()], covers: (repo) => rulesByOwner.has(repo.slice(0, repo.indexOf("/"))) };
}

export function withBareAllowHost(policy: SandboxNetworkPolicy, host: string): SandboxNetworkPolicy {
  if (typeof policy === "string") return policy;
  const allow: Record<string, EgressRule[]> = { ...(policy.allow as Record<string, EgressRule[]>) };
  allow[host] = [];
  return { ...policy, allow };
}
