import type { SessionMode } from "../access/resolver.js";
import type { Visibility } from "../identity/binding.js";

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
}

export function buildNotionAuth(input: NotionIdentityInput): OpenEverywhereNotionAuth {
  const attributes: Record<string, string> = {};
  if (input.workspaceId) attributes.workspace_id = input.workspaceId;
  if (input.pageId) attributes.page_id = input.pageId;
  if (input.discussionId) attributes.discussion_id = input.discussionId;
  if (input.commentId) attributes.comment_id = input.commentId;
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

export function notionMode(): SessionMode {
  return "channel";
}

export function notionVisibility(): Visibility {
  return "private";
}
