import { callTeamsConnectorApi, type TeamsHandle } from "eve/channels/teams";
import { dmTrustTtlMs } from "@open-everywhere/core/agent/adapter-api.js";
import { teamsUserTypeFromMember } from "./teams-identity.js";

export interface TeamsRosterResponse {
  readonly ok: boolean;
  readonly body: unknown;
}

export type TeamsRosterProbe = (path: string) => Promise<TeamsRosterResponse>;

export function teamsRosterMemberPath(conversationId: string, userId: string): string {
  return `/v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`;
}

export function teamsHandleRosterProbe(teams: Pick<TeamsHandle, "request">): TeamsRosterProbe {
  return (path) => teams.request(path, undefined as unknown as Parameters<TeamsHandle["request"]>[1], { method: "GET" });
}

export function teamsServiceUrlRosterProbe(serviceUrl: string | undefined): TeamsRosterProbe | undefined {
  if (!serviceUrl) return undefined;
  return (path) => callTeamsConnectorApi({ serviceUrl, path, method: "GET" });
}

const teamsUserTypeCache = new Map<string, { userType: "guest" | "member"; at: number }>();

const TEAMS_REPLY_CHAIN_SUFFIX = ";messageid=";

function teamsRosterCacheConversationId(conversationId: string): string {
  const i = conversationId.lastIndexOf(TEAMS_REPLY_CHAIN_SUFFIX);
  return i < 0 ? conversationId : conversationId.slice(0, i);
}

export async function resolveTeamsUserType(
  probe: TeamsRosterProbe | undefined,
  conversationId: string | undefined,
  userId: string | undefined,
): Promise<"guest" | "member" | undefined> {
  if (!probe || !conversationId || !userId) return undefined;
  const key = `${teamsRosterCacheConversationId(conversationId)}:${userId}`;
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

export function _resetTeamsUserTypeCacheForTest(): void {
  teamsUserTypeCache.clear();
}
