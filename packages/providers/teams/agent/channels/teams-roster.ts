import { callTeamsConnectorApi, resolveTeamsTenantId, type TeamsHandle } from "eve/channels/teams";
import { dmTrustTtlMs } from "@open-everywhere/core/agent/adapter-api.js";
import { teamsUserTypeFromMember } from "./teams-identity.js";
import { teamsChannelGrainConversationId } from "./teams-conversation-ref.js";
import { isTrustedTeamsServiceUrl } from "./teams-origin-codec.js";

export interface TeamsRosterResponse {
  readonly ok: boolean;
  readonly body: unknown;
}

export type TeamsRosterProbe = (path: string) => Promise<TeamsRosterResponse>;

export function teamsRosterMemberPath(conversationId: string, userId: string): string {
  return `/v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`;
}

export function teamsHandleRosterProbe(teams: Pick<TeamsHandle, "request" | "serviceUrl">): TeamsRosterProbe | undefined {
  if (!isTrustedTeamsServiceUrl(teams.serviceUrl)) return undefined;
  return (path) => teams.request(path, undefined as unknown as Parameters<TeamsHandle["request"]>[1], { method: "GET" });
}

export function teamsServiceUrlRosterProbe(serviceUrl: string | undefined): TeamsRosterProbe | undefined {
  if (!serviceUrl || !isTrustedTeamsServiceUrl(serviceUrl)) return undefined;
  return (path) => callTeamsConnectorApi({ serviceUrl, path, method: "GET" });
}

const teamsUserTypeCache = new Map<string, { userType: "guest" | "member"; at: number }>();

export async function resolveTeamsUserType(
  probe: TeamsRosterProbe | undefined,
  conversationId: string | undefined,
  userId: string | undefined,
): Promise<"guest" | "member" | undefined> {
  if (!probe || !conversationId || !userId) return undefined;
  const key = `${teamsChannelGrainConversationId(conversationId)}:${userId}`;
  const hit = teamsUserTypeCache.get(key);
  if (hit && Date.now() - hit.at < dmTrustTtlMs()) return hit.userType;
  try {
    const res = await probe(teamsRosterMemberPath(conversationId, userId));
    if (!res.ok) return undefined;
    const userType = teamsUserTypeFromMember(res.body);
    if (userType) teamsUserTypeCache.set(key, { userType, at: Date.now() });
    return userType;
  } catch {
    return undefined;
  }
}

export async function teamsIsHomeTenant(
  tenantId: string | undefined,
  resolveHome: () => Promise<string | undefined> = () => resolveTeamsTenantId(),
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const home = await resolveHome();
    return typeof home === "string" && home.length > 0 && home.toLowerCase() === tenantId.toLowerCase();
  } catch {
    return false;
  }
}

export function _resetTeamsUserTypeCacheForTest(): void {
  teamsUserTypeCache.clear();
}
