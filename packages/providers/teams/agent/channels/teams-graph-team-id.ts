import { callTeamsConnectorApi } from "./teams-connector.js";

const GRAPH_TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOLVED = new Map<string, string>();

export interface TeamsTeamDetailsResponse {
  readonly ok: boolean;
  readonly body: unknown;
}

export interface TeamsGraphTeamIdDeps {
  readonly request: (args: { readonly serviceUrl: string; readonly path: string }) => Promise<TeamsTeamDetailsResponse>;
}

const liveDeps: TeamsGraphTeamIdDeps = {
  request: ({ serviceUrl, path }) => callTeamsConnectorApi({ serviceUrl, path, method: "GET" }),
};

export async function teamsGraphTeamId(
  botTeamId: string | undefined,
  serviceUrl: string | undefined,
  deps: TeamsGraphTeamIdDeps = liveDeps,
): Promise<string | undefined> {
  if (!botTeamId) return undefined;
  if (GRAPH_TEAM_ID.test(botTeamId)) return botTeamId;
  const cached = RESOLVED.get(botTeamId);
  if (cached !== undefined) return cached;
  if (!serviceUrl) return undefined;
  try {
    const res = await deps.request({ serviceUrl, path: `/v3/teams/${encodeURIComponent(botTeamId)}` });
    if (!res.ok) return undefined;
    const aadGroupId = (res.body as { readonly aadGroupId?: unknown } | undefined)?.aadGroupId;
    if (typeof aadGroupId !== "string" || !GRAPH_TEAM_ID.test(aadGroupId)) return undefined;
    RESOLVED.set(botTeamId, aadGroupId);
    return aadGroupId;
  } catch {
    return undefined;
  }
}

export function _resetTeamsGraphTeamIdCache(): void {
  RESOLVED.clear();
}

export function _seedTeamsGraphTeamIdForTest(botTeamId: string, graphTeamId: string): void {
  RESOLVED.set(botTeamId, graphTeamId);
}
