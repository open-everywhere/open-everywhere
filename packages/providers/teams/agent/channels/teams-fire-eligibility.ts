import type {
  TeamsAccountActiveCheck,
  TeamsMembershipUnresolved,
  TeamsRoomMembership,
  TeamsRoomMembershipCheck,
} from "@open-everywhere/core/agent/adapter-api.js";
import { teamsGraphTeamId } from "./teams-graph-team-id.js";
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

function unresolved(cause: TeamsMembershipUnresolved): TeamsRoomMembership {
  return { member: undefined, unresolved: cause };
}

export async function teamsRoomMembershipViaGraph(
  botTeamId: string,
  channelId: string,
  aadObjectId: string,
  serviceUrl: string | undefined,
  req: TeamsGraphRequester,
): Promise<TeamsRoomMembership> {
  if (botTeamId.length === 0 || channelId.length === 0 || aadObjectId.length === 0) return unresolved("missing_ids");
  const graphTeamId = await teamsGraphTeamId(botTeamId, serviceUrl);
  if (graphTeamId === undefined) return unresolved("team_id_unresolved");
  try {
    let url: string | undefined = `${GRAPH_BASE}/teams/${encodeURIComponent(graphTeamId)}/channels/${encodeURIComponent(channelId)}/members`;
    for (let page = 0; page < TEAMS_MEMBER_MAX_PAGES && url; page++) {
      const json = (await req(url)) as GraphMemberPage;
      if (!Array.isArray(json.value)) return unresolved("malformed_response");
      if (json.value.some((m) => m.userId === aadObjectId)) return { member: true };
      url = typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : undefined;
    }
    return url ? unresolved("roster_incomplete") : { member: false };
  } catch {
    return unresolved("read_error");
  }
}

export const liveTeamsRoomMembership: TeamsRoomMembershipCheck = (teamId, channelId, aadObjectId, serviceUrl) =>
  teamsRoomMembershipViaGraph(teamId, channelId, aadObjectId, serviceUrl, liveTeamsGraphRequest);

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
