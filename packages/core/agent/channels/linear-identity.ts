export interface OpenEverywhereLinearAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface LinearIdentityInput {
  readonly organizationId?: string;
  readonly teamId?: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
  readonly agentSessionId?: string;
  readonly principalId?: string;
  readonly guest?: boolean;
  readonly isPrivate?: boolean;
  readonly commentId?: string;
  readonly parentCommentId?: string;
}

export interface LinearTeamFacts {
  readonly isPrivate?: boolean;
}

export function teamFactsFromTeam(data: unknown): LinearTeamFacts {
  const team = (data as { team?: Record<string, unknown> } | null)?.team;
  if (!team || typeof team !== "object") return {};
  const isPrivate = typeof team["private"] === "boolean" ? (team["private"] as boolean) : undefined;
  return { isPrivate };
}

export function userGuestFromUser(user: unknown): { readonly guest?: boolean } {
  if (!user || typeof user !== "object") return {};
  const g = (user as Record<string, unknown>)["guest"];
  return { guest: typeof g === "boolean" ? g : undefined };
}

export function buildLinearAuth(input: LinearIdentityInput): OpenEverywhereLinearAuth {
  const attributes: Record<string, string> = {};
  if (input.agentSessionId) attributes.agent_session_id = input.agentSessionId;
  if (input.organizationId) attributes.organization_id = input.organizationId;
  if (input.teamId) attributes.team_id = input.teamId;
  if (input.issueId) attributes.issue_id = input.issueId;
  if (input.issueIdentifier) attributes.issue_identifier = input.issueIdentifier;
  if (typeof input.guest === "boolean") attributes.guest = String(input.guest);
  if (typeof input.isPrivate === "boolean") attributes.is_private = String(input.isPrivate);
  if (input.commentId) attributes.comment_id = input.commentId;
  if (input.parentCommentId) attributes.parent_comment_id = input.parentCommentId;
  return {
    authenticator: "linear",
    principalId: input.principalId ?? "",
    principalType: "linear-user",
    attributes,
  };
}
