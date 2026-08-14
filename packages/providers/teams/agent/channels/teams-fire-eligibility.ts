import type { TeamsAccountActiveCheck, TeamsRoomMembershipCheck } from "@open-everywhere/core/agent/adapter-api.js";
import { liveTeamsGraphRequest, type TeamsGraphRequester } from "./teams-read.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const TEAMS_MEMBER_MAX_PAGES = 10;

interface GraphConversationMember {
  readonly userId?: string;
}

interface GraphMemberPage {
  readonly value?: readonly GraphConversationMember[];
  readonly ["@odata.nextLink"]?: string;
}

export async function teamsRoomMembershipViaGraph(teamId: string, channelId: string, aadObjectId: string, req: TeamsGraphRequester): Promise<boolean | undefined> {
  if (teamId.length === 0 || channelId.length === 0 || aadObjectId.length === 0) return undefined;
  try {
    let url: string | undefined = `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/members`;
    for (let page = 0; page < TEAMS_MEMBER_MAX_PAGES && url; page++) {
      const json = (await req(url)) as GraphMemberPage;
      if (!Array.isArray(json.value)) return undefined;
      if (json.value.some((m) => m.userId === aadObjectId)) return true;
      url = typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : undefined;
    }
    return url ? undefined : false;
  } catch {
    return undefined;
  }
}

export const liveTeamsRoomMembership: TeamsRoomMembershipCheck = (teamId, channelId, aadObjectId) => teamsRoomMembershipViaGraph(teamId, channelId, aadObjectId, liveTeamsGraphRequest);

interface GraphUser {
  readonly accountEnabled?: boolean;
}

export async function teamsAccountActiveViaGraph(aadObjectId: string, req: TeamsGraphRequester): Promise<boolean | undefined> {
  if (aadObjectId.length === 0) return undefined;
  try {
    const json = (await req(`${GRAPH_BASE}/users/${encodeURIComponent(aadObjectId)}?$select=accountEnabled`)) as GraphUser;
    if (typeof json?.accountEnabled !== "boolean") return undefined;
    return json.accountEnabled;
  } catch {
    return undefined;
  }
}

export const liveTeamsAccountActive: TeamsAccountActiveCheck = (aadObjectId) => teamsAccountActiveViaGraph(aadObjectId, liveTeamsGraphRequest);
