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
  readonly agentSessionId: string;
  readonly principalId?: string;
  readonly isPrivate?: boolean;
}

export function buildLinearAuth(input: LinearIdentityInput): OpenEverywhereLinearAuth {
  const attributes: Record<string, string> = { agent_session_id: input.agentSessionId };
  if (input.organizationId) attributes.organization_id = input.organizationId;
  if (input.teamId) attributes.team_id = input.teamId;
  if (input.issueId) attributes.issue_id = input.issueId;
  if (input.issueIdentifier) attributes.issue_identifier = input.issueIdentifier;
  if (typeof input.isPrivate === "boolean") attributes.is_private = String(input.isPrivate);
  return {
    authenticator: "linear",
    principalId: input.principalId ?? "",
    principalType: "linear-user",
    attributes,
  };
}
