export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface ConfigFileContent {
  readonly content: string;
  readonly sha: string;
}

export interface ConfigPrOutcome {
  readonly url: string;
  readonly number: number;
  readonly updated: boolean;
  readonly reopened: boolean;
}

export interface ConfigPrProvider {
  resolveWriteToken(repo: string): Promise<string>;

  committer(): CommitIdentity;

  getBranchSha(args: { repo: string; branch: string; token: string }): Promise<string | null>;

  ensureBranch(args: { repo: string; branch: string; sha: string; token: string }): Promise<void>;

  getFile(args: { repo: string; path: string; branch: string; token: string }): Promise<ConfigFileContent | null>;

  putFile(args: {
    repo: string;
    path: string;
    content: string;
    message: string;
    branch: string;
    token: string;
    committer: CommitIdentity;
    sha?: string;
  }): Promise<void>;

  openOrReopenPr(args: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    token: string;
  }): Promise<ConfigPrOutcome>;
}

let registered: ConfigPrProvider | undefined;

export function registerConfigPrProvider(provider: ConfigPrProvider): void {
  registered = provider;
}

export function getConfigPrProvider(): ConfigPrProvider {
  if (!registered) {
    throw new Error(
      "no ConfigPrProvider registered — the app must register a config-repo PR mechanism at boot " +
        "(e.g. registerGitHubConfigPrProvider for GitHub, via agent/lib/register-adapters.ts).",
    );
  }
  return registered;
}
