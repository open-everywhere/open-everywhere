import type { BindableContext, IdentityMapper, IngestedChatMessage, RawIdentity, Visibility } from "@open-everywhere/core/agent/adapter-api.js";

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

export function linearVisibility(isPrivate: string | undefined): Visibility {
  if (isPrivate === "false") return "public";
  return "private";
}

export function linearTrust(guest: string | undefined): RawIdentity["trust"] {
  if (guest === "true") return "external";
  return undefined;
}

export function linearAuthorFacts(guest: boolean | undefined): IngestedChatMessage {
  return guest === true ? { refuted: true } : {};
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function linearAuthOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function linearAuthPrincipalId(ctx: BindableContext): string | undefined {
  const pid = linearAuthOf(ctx)?.principalId;
  return pid && pid.length > 0 ? pid : undefined;
}

function linearAttr(a: AuthAttrs, keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

export const bindLinear: IdentityMapper = (ctx): RawIdentity => {
  const a = linearAuthOf(ctx)?.attributes;
  const surface =
    linearAttr(a, ["team_id", "teamId"]) ??
    linearAttr(a, ["issue_id", "issueId"]) ??
    linearAttr(a, ["issue_identifier", "issueIdentifier"]) ??
    linearAttr(a, ["agent_session_id", "agentSessionId"]);
  const agentSessionId = linearAttr(a, ["agent_session_id", "agentSessionId"]);
  return {
    workspace: linearAttr(a, ["organization_id", "organizationId"]),
    surface,
    mode: "channel",
    visibility: linearVisibility(linearAttr(a, ["is_private", "isPrivate"])),
    trust: linearTrust(linearAttr(a, ["guest"])),
    principalId: linearAuthPrincipalId(ctx) ?? linearAttr(a, ["creator_id", "creatorId", "user_id", "userId"]),
    target: agentSessionId ? { agentSessionId } : undefined,
  };
};
