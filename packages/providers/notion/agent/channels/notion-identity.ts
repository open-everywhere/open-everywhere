import type { SessionMode, Visibility, BindableContext, IdentityMapper, RawIdentity } from "@open-everywhere/core/agent/adapter-api.js";

export interface OpenEverywhereNotionAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface NotionIdentityInput {
  readonly workspaceId?: string;
  readonly pageId?: string;
  readonly discussionId?: string;
  readonly commentId?: string;
  readonly principalId?: string;
  readonly credentialId?: string;
  readonly trustRoot?: string;
}

export function buildNotionAuth(input: NotionIdentityInput): OpenEverywhereNotionAuth {
  const attributes: Record<string, string> = {};
  if (input.workspaceId) attributes.workspace_id = input.workspaceId;
  if (input.pageId) attributes.page_id = input.pageId;
  if (input.discussionId) attributes.discussion_id = input.discussionId;
  if (input.commentId) attributes.comment_id = input.commentId;
  if (input.credentialId) attributes.credential_id = input.credentialId;
  if (input.trustRoot) attributes.trust_root = input.trustRoot;
  return {
    authenticator: "notion",
    principalId: input.principalId ?? "",
    principalType: "notion-user",
    attributes,
  };
}

export function notionWorkspaceKey(workspaceId: string): string {
  return `notion/${workspaceId}`;
}

export function notionSurfaceKey(workspaceId: string | undefined, surface: string | undefined): string {
  return `notion/${workspaceId ?? "unknown"}/${surface ?? "unknown"}`;
}

export function notionMode(): SessionMode {
  return "channel";
}

export function notionVisibility(): Visibility {
  return "private";
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function notionAuthOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function notionAttr(a: AuthAttrs, keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

export const bindNotion: IdentityMapper = (ctx): RawIdentity => {
  const auth = notionAuthOf(ctx);
  const a = auth?.attributes;
  const workspaceId = notionAttr(a, ["workspace_id", "workspaceId"]);
  const surface =
    notionAttr(a, ["page_id", "pageId"]) ??
    notionAttr(a, ["discussion_id", "discussionId"]) ??
    notionAttr(a, ["comment_id", "commentId"]);
  const discussionId = notionAttr(a, ["discussion_id", "discussionId"]);
  const pageId = notionAttr(a, ["page_id", "pageId"]);
  const credentialId = notionAttr(a, ["credential_id", "credentialId"]);
  const trustRoot = notionAttr(a, ["trust_root", "trustRoot"]);
  const principal = auth?.principalId;
  return {
    workspace: workspaceId,
    surface,
    mode: notionMode(),
    visibility: notionVisibility(),
    trust: trustRoot ? ("internal" as const) : undefined,
    principalId: (principal && principal.length > 0 ? principal : undefined) ?? notionAttr(a, ["user_id", "userId"]),
    target: discussionId ? { discussionId, ...(pageId ? { pageId } : {}), ...(credentialId ? { credentialId } : {}) } : undefined,
  };
};
