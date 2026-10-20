import { type KeyObject } from "node:crypto";
import {
  parsePrivateKey,
  signAppJwt,
  mintInstallationToken,
  type FetchFn,
} from "./mint.js";
import { botCommitter } from "./git.js";
import type { GitHubAppConfig, InstallationToken, MintPermissions, RepoRef } from "./types.js";

export interface MintOutcome {
  readonly tokens: Map<string, InstallationToken>;
  readonly ungranted: RepoRef[];
}

export class GitHubApp {
  private parsed: { readonly pem: string; readonly key: KeyObject } | undefined;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly deps: {
      fetchFn?: FetchFn;
      now?: () => number;
      discovered?: (owner: string) => string | undefined;
      hydrate?: () => Promise<void>;
    } = {},
  ) {}

  private async key(): Promise<KeyObject> {
    const source = this.config.privateKeyPem;
    const pem = typeof source === "string" ? source : await source();
    if (!pem) throw new Error("the GitHub App private key is not set — store it with `oe secret set GITHUB_APP_PRIVATE_KEY`.");
    if (this.parsed?.pem !== pem) this.parsed = { pem, key: parsePrivateKey(pem) };
    return this.parsed.key;
  }

  private nowSeconds(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  private issuer(): string {
    return this.config.clientId ?? this.config.appId;
  }

  installationFor(owner: string): string | undefined {
    return this.config.installations[owner] ?? this.deps.discovered?.(owner);
  }

  async tokensForRepos(repos: readonly RepoRef[], permissions?: MintPermissions): Promise<MintOutcome> {
    await this.deps.hydrate?.();
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
      const jwt = await signAppJwt(await this.key(), this.issuer(), this.nowSeconds());
      tokens.set(
        owner,
        await mintInstallationToken({
          jwt,
          installationId: this.installationFor(owner)!,
          repoNames: names,
          permissions,
          fetchFn: this.deps.fetchFn,
        }),
      );
    }
    return { tokens, ungranted };
  }

  async installationPermissions(owner: string): Promise<Readonly<Record<string, string>> | undefined> {
    await this.deps.hydrate?.();
    const installationId = this.installationFor(owner);
    if (!installationId) return undefined;
    const fetchFn = (this.deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn)) as unknown as (
      url: string,
      init: { method: string; headers: Record<string, string> },
    ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
    try {
      const jwt = await signAppJwt(await this.key(), this.issuer(), this.nowSeconds());
      const res = await fetchFn(`https://api.github.com/app/installations/${installationId}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { permissions?: unknown };
      const perms = body?.permissions;
      if (perms === null || typeof perms !== "object" || Array.isArray(perms)) return undefined;
      const out: Record<string, string> = {};
      for (const [family, grade] of Object.entries(perms as Record<string, unknown>)) {
        if (typeof grade === "string") out[family] = grade;
      }
      return out;
    } catch {
      return undefined;
    }
  }

  committer(): { name: string; email: string } {
    return botCommitter(this.config.appSlug, this.config.botUserId ?? this.config.appId);
  }
}
