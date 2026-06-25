import type { SessionMode } from "../access/resolver.js";

export interface OpenEverywhereTeamsAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface TeamsIdentityInput {
  readonly userId: string;
  readonly aadObjectId?: string;
  readonly userName?: string;
  readonly tenantId?: string;
  readonly conversationId: string;
  readonly channelId?: string;
  readonly teamId?: string;
  readonly serviceUrl?: string;
  readonly scope?: string;
  readonly membershipType?: string;
}

export function buildTeamsAuth(input: TeamsIdentityInput): OpenEverywhereTeamsAuth {
  const attributes: Record<string, string> = {
    conversation_id: input.conversationId,
    user_id: input.userId,
  };
  if (input.aadObjectId) attributes.aad_object_id = input.aadObjectId;
  if (input.userName) attributes.user_name = input.userName;
  if (input.tenantId) attributes.tenant_id = input.tenantId;
  if (input.channelId) attributes.channel_id = input.channelId;
  if (input.teamId) attributes.team_id = input.teamId;
  if (input.serviceUrl) attributes.service_url = input.serviceUrl;
  if (input.scope) attributes.scope = input.scope;
  if (input.membershipType) attributes.membership_type = input.membershipType;
  return { authenticator: "teams", principalId: input.userId, principalType: "teams-user", attributes };
}

export function teamsMembershipType(channelData: Record<string, unknown> | undefined): string | undefined {
  const ch = (channelData as { channel?: Record<string, unknown> } | undefined)?.channel;
  if (!ch || typeof ch !== "object") return undefined;
  const mt = ch["membershipType"];
  return typeof mt === "string" && mt.length > 0 ? mt : undefined;
}

export function teamsMode(scope: string | undefined): SessionMode {
  if (scope === "personal") return "dm";
  if (scope === "groupChat") return "mpim";
  if (scope === "channel") return "channel";
  return "channel";
}

export function teamsVisibility(
  scope: string | undefined,
  membershipType: string | undefined,
  mode: SessionMode,
): Visibility {
  if (mode === "dm" || mode === "mpim") return "private";
  if (scope === "personal" || scope === "groupChat") return "private";
  if (membershipType === "standard") return "public";
  return "private";
}

type Visibility = "public" | "private";
