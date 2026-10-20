export type RepoRef = string;

export interface MintPermissions {
  readonly contents?: "read" | "write";
  readonly pull_requests?: "read" | "write";
  readonly metadata?: "read";
  readonly issues?: "read" | "write";
  readonly workflows?: "write";
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly repositories: readonly string[];
}

export interface GitHubAppConfig {
  readonly appId: string;
  readonly clientId?: string;
  readonly privateKeyPem: string | (() => Promise<string | undefined>);
  readonly appSlug: string;
  readonly botUserId?: string;
  readonly installations: Readonly<Record<string, string>>;
}
