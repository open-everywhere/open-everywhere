import type { SandboxNetworkPolicy } from "eve/sandbox";
import { GIT_BROKER_HOSTS, type EgressRule } from "../access/egress.js";
import type { GitHubApp } from "./app.js";
import { READ_PERMISSIONS } from "./mint.js";

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
  if (rulesByOwner.size === 0) return base;
  const rules = [...rulesByOwner.values()];
  const allow: Record<string, EgressRule[]> = typeof base === "string" ? {} : { ...(base.allow as Record<string, EgressRule[]>) };
  for (const host of GIT_BROKER_HOSTS) allow[host] = rules;
  return { allow };
}

export function withBareAllowHost(policy: SandboxNetworkPolicy, host: string): SandboxNetworkPolicy {
  if (typeof policy === "string") return policy;
  const allow: Record<string, EgressRule[]> = { ...(policy.allow as Record<string, EgressRule[]>) };
  allow[host] = [];
  return { ...policy, allow };
}
