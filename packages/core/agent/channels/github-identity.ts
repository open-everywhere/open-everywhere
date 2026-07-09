export interface OpenEverywhereGitHubAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface GitHubIdentityInput {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryFullName?: string;
  readonly repositoryId?: number;
  readonly isPrivate?: boolean;
  readonly conversationKind?: string;
  readonly issueNumber?: number;
  readonly pullRequestNumber?: number;
  readonly installationId?: number;
  readonly actorLogin: string;
  readonly actorId?: number;
  readonly actorType?: string;
  readonly authorAssociation?: string;
}

export function buildGitHubAuth(input: GitHubIdentityInput): OpenEverywhereGitHubAuth {
  const attributes: Record<string, string> = {
    owner: input.owner,
    repo: input.repo,
    user_login: input.actorLogin,
  };
  if (input.repositoryFullName) attributes.repository = input.repositoryFullName;
  if (typeof input.repositoryId === "number") attributes.repository_id = String(input.repositoryId);
  if (typeof input.isPrivate === "boolean") attributes.repo_private = String(input.isPrivate);
  if (input.conversationKind) attributes.conversation_kind = input.conversationKind;
  if (typeof input.issueNumber === "number") attributes.issue_number = String(input.issueNumber);
  if (typeof input.pullRequestNumber === "number") attributes.pull_request_number = String(input.pullRequestNumber);
  if (typeof input.installationId === "number") attributes.installation_id = String(input.installationId);
  if (typeof input.actorId === "number") attributes.user_id = String(input.actorId);
  if (input.actorType) attributes.user_type = input.actorType;
  if (input.authorAssociation) attributes.author_association = input.authorAssociation;
  return {
    authenticator: "github",
    principalId: input.actorLogin,
    principalType: input.actorType === "Bot" ? "service" : "github-user",
    attributes,
  };
}

export function githubBotMentioned(
  body: string | undefined,
  botName: string | undefined,
  author: { readonly login?: string; readonly type?: string } | undefined,
): boolean {
  const name = botName?.trim();
  if (!name || !body) return false;
  if (body.includes("<!-- eve:github:")) return false;
  if (author?.type === "Bot") return false;
  if (author?.login && author.login.toLowerCase() === `${name}[bot]`.toLowerCase()) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu").test(body);
}

export function githubVisibility(repoPrivate: string | undefined): Visibility {
  if (repoPrivate === "false") return "public";
  return "private";
}

export function githubTrust(repoPrivate: string | undefined, authorAssociation: string | undefined): Trust | undefined {
  if (repoPrivate !== "true") return undefined;
  if (authorAssociation === "OWNER" || authorAssociation === "MEMBER") return "internal";
  return undefined;
}

type Visibility = "public" | "private";
type Trust = "internal" | "external";
