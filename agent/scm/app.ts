import { type KeyObject } from "node:crypto";
import {
  parsePrivateKey,
  signAppJwt,
  mintInstallationToken,
  type FetchFn,
} from "./mint.js";
import { botCommitter } from "./git.js";
import type { GitHubAppConfig, InstallationToken, RepoRef } from "./types.js";

export interface MintOutcome {
  readonly tokens: Map<string, InstallationToken>;
  readonly ungranted: RepoRef[];
}

export class GitHubApp {
  private readonly key: KeyObject;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly deps: { fetchFn?: FetchFn; now?: () => number } = {},
  ) {
    this.key = parsePrivateKey(config.privateKeyPem);
  }

  private nowSeconds(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  private issuer(): string {
    return this.config.clientId ?? this.config.appId;
  }

  installationFor(owner: string): string | undefined {
    return this.config.installations[owner];
  }

  async tokensForRepos(repos: readonly RepoRef[]): Promise<MintOutcome> {
    const byOwner = new Map<string, string[]>();
    const ungranted: RepoRef[] = [];
    for (const ref of repos) {
      const slash = ref.indexOf("/");
      if (slash <= 0 || slash === ref.length - 1) continue;
      const owner = ref.slice(0, slash);
      const name = ref.slice(slash + 1);
      if (!this.installationFor(owner)) {
        ungranted.push(ref);
        continue;
      }
      const list = byOwner.get(owner);
      if (list) list.push(name);
      else byOwner.set(owner, [name]);
    }

    const tokens = new Map<string, InstallationToken>();
    for (const [owner, names] of byOwner) {
      const jwt = await signAppJwt(this.key, this.issuer(), this.nowSeconds());
      tokens.set(
        owner,
        await mintInstallationToken({
          jwt,
          installationId: this.installationFor(owner)!,
          repoNames: names,
          fetchFn: this.deps.fetchFn,
        }),
      );
    }
    return { tokens, ungranted };
  }

  committer(): { name: string; email: string } {
    return botCommitter(this.config.appSlug, this.config.botUserId ?? this.config.appId);
  }
}
