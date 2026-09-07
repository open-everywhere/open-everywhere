import type { SessionMode, BindableContext, IdentityMapper, RawIdentity } from "@open-everywhere/core/agent/adapter-api.js";
import { rootDmGrainAttrs } from "@open-everywhere/core/agent/adapter-api.js";

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
  readonly userType?: string;
}

const TEAMS_USER_TYPE_ATTR = "user_type";

export function withTeamsUserType<A extends OpenEverywhereTeamsAuth>(auth: A, userType: string | undefined): A {
  if (!userType) return auth;
  return { ...auth, attributes: { ...auth.attributes, [TEAMS_USER_TYPE_ATTR]: userType } };
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
  if (input.userType) attributes[TEAMS_USER_TYPE_ATTR] = input.userType;
  const teamsScopeMode = teamsMode(input.scope);
  Object.assign(attributes, rootDmGrainAttrs(teamsScopeMode === "dm" || teamsScopeMode === "mpim"));
  return { authenticator: "teams", principalId: input.userId, principalType: "teams-user", attributes };
}

export function teamsMembershipType(channelData: Record<string, unknown> | undefined): string | undefined {
  const ch = (channelData as { channel?: Record<string, unknown> } | undefined)?.channel;
  if (!ch || typeof ch !== "object") return undefined;
  const mt = ch["membershipType"];
  return typeof mt === "string" && mt.length > 0 ? mt : undefined;
}

export function teamsUserTypeFromMember(info: unknown): "guest" | "member" | undefined {
  if (!info || typeof info !== "object") return undefined;
  const o = info as Record<string, unknown>;
  const raw = o["userType"] ?? o["userRole"];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const v = raw.toLowerCase();
  if (v === "guest") return "guest";
  if (v === "member" || v === "user" || v === "owner" || v === "admin" || v === "organizer") return "member";
  return undefined;
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

export function teamsTrust(
  scope: string | undefined,
  membershipType: string | undefined,
  mode: SessionMode,
  tenantId?: string,
  userType?: string,
): Trust | undefined {
  if (userType === "guest") return "external";
  if (mode === "dm" || mode === "mpim") return "internal";
  if (scope === "personal" || scope === "groupChat") return "internal";
  if (membershipType === "shared") return "external";
  if (tenantId && (membershipType === "standard" || membershipType === "private")) {
    return "internal";
  }
  return undefined;
}

type Visibility = "public" | "private";
type Trust = "internal" | "external";

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function teamsAuthOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function teamsAttr(a: AuthAttrs, keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

function teamsAuthPrincipalId(ctx: BindableContext): string | undefined {
  const pid = teamsAuthOf(ctx)?.principalId;
  return pid && pid.length > 0 ? pid : undefined;
}

export function teamsTrustGroup(teamId: string | undefined): { readonly trustGroup: string } | undefined {
  if (teamId === undefined || !/^[a-zA-Z0-9._-]+$/.test(teamId)) return undefined;
  return { trustGroup: `team:${teamId}` };
}

export const bindTeams: IdentityMapper = (ctx): RawIdentity => {
  const a = teamsAuthOf(ctx)?.attributes;
  const scope = teamsAttr(a, ["scope"]);
  const membershipType = teamsAttr(a, ["membership_type", "membershipType"]);
  const userType = teamsAttr(a, ["user_type", "userType"]);
  const mode = teamsMode(scope);
  const conversationId = teamsAttr(a, ["conversation_id", "conversationId"]);
  const serviceUrl = teamsAttr(a, ["service_url", "serviceUrl"]);
  const tenantId = teamsAttr(a, ["tenant_id", "tenantId"]);
  return {
    workspace: tenantId,
    surface: conversationId,
    domainSurface: teamsAttr(a, ["channel_id", "channelId"]),
    mode,
    ...(teamsTrustGroup(teamsAttr(a, ["team_id", "teamId"])) ?? {}),
    visibility: teamsVisibility(scope, membershipType, mode),
    trust: teamsTrust(scope, membershipType, mode, tenantId, userType),
    principalId: teamsAuthPrincipalId(ctx) ?? teamsAttr(a, ["user_id", "userId"]),
    ...(teamsMode(scope) !== "dm" && conversationId ? { engagementKey: conversationId } : {}),
    ...(conversationId ? { anchorChannelId: conversationId } : {}),
    target:
      conversationId && serviceUrl
        ? {
            serviceUrl,
            conversationId,
            tenantId,
            channelId: teamsAttr(a, ["channel_id", "channelId"]),
            teamId: teamsAttr(a, ["team_id", "teamId"]),
            conversationType: scope,
            aadObjectId: teamsAttr(a, ["aad_object_id", "aadObjectId"]),
          }
        : undefined,
  };
};
