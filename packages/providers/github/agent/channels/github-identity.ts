import type { BindableContext, IdentityMapper, IngestedChatMessage, RawIdentity } from "@open-everywhere/core/agent/adapter-api.js";

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
  readonly reviewThreadRootCommentId?: number;
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
  if (typeof input.reviewThreadRootCommentId === "number") attributes.review_thread_root_comment_id = String(input.reviewThreadRootCommentId);
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

export const GITHUB_INTERNAL_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

export const GITHUB_EXTERNAL_ASSOCIATIONS: readonly string[] = [
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
  "MANNEQUIN",
];

export function githubAssociationRefutes(authorAssociation: string | undefined): boolean {
  return authorAssociation !== undefined && GITHUB_EXTERNAL_ASSOCIATIONS.includes(authorAssociation);
}

export function githubAuthorFacts(input: {
  readonly authorAssociation?: string;
  readonly actorType?: string;
}): IngestedChatMessage {
  if (input.actorType === "Bot") return { trust: "relay" };
  return githubAssociationRefutes(input.authorAssociation) ? { refuted: true } : {};
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function githubAuthOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function githubAttr(a: AuthAttrs, keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

function githubAuthPrincipalId(ctx: BindableContext): string | undefined {
  const pid = githubAuthOf(ctx)?.principalId;
  return pid && pid.length > 0 ? pid : undefined;
}

export function githubConversationKey(owner: string | undefined, repo: string | undefined, number: number | undefined): string | undefined {
  return owner && repo && Number.isFinite(number) ? `${owner}/${repo}#${number}` : undefined;
}

export function githubReviewThreadRoot(ctx: BindableContext): string | undefined {
  const raw = githubAttr(githubAuthOf(ctx)?.attributes, ["review_thread_root_comment_id", "reviewThreadRootCommentId"]);
  return raw !== undefined && /^\d+$/u.test(raw) ? raw : undefined;
}

export const bindGitHub: IdentityMapper = (ctx): RawIdentity => {
  const a = githubAuthOf(ctx)?.attributes;
  const owner = githubAttr(a, ["owner"]);
  const repo = githubAttr(a, ["repo"]);
  const repoPrivate = githubAttr(a, ["repo_private", "repoPrivate"]);
  const conversationKind = githubAttr(a, ["conversation_kind", "conversationKind"]);
  const issueNumber = githubAttr(a, ["issue_number", "issueNumber"]);
  const pullRequestNumber = githubAttr(a, ["pull_request_number", "pullRequestNumber"]);
  const installationId = githubAttr(a, ["installation_id", "installationId"]);
  const isPr = conversationKind === "pull_request" || conversationKind === "review_thread";
  const anchor =
    isPr && pullRequestNumber
      ? { pullRequestNumber: Number(pullRequestNumber) }
      : issueNumber
        ? { issueNumber: Number(issueNumber) }
        : pullRequestNumber
          ? { pullRequestNumber: Number(pullRequestNumber) }
          : undefined;
  return {
    workspace: owner,
    surface: repo,
    mode: "channel",
    visibility: githubVisibility(repoPrivate),
    trust: githubTrust(repoPrivate, githubAttr(a, ["author_association", "authorAssociation"])),
    principalId: githubAuthPrincipalId(ctx) ?? githubAttr(a, ["user_login", "userLogin", "user_id", "userId"]),
    target: owner && repo && anchor ? { owner, repo, ...anchor, ...(installationId ? { installationId: Number(installationId) } : {}) } : undefined,
    ...(anchor
      ? {
          anchorChannelId: githubConversationKey(
            owner,
            repo,
            "pullRequestNumber" in anchor ? anchor.pullRequestNumber : anchor.issueNumber,
          ),
        }
      : {}),
  };
};
