import { type DirectoryCandidate } from "@open-everywhere/core/agent/adapter-api.js";
import { callTeamsConnectorApi } from "eve/channels/teams";
import { teamsTeamConversationRefs, type TeamsConversationRef } from "./teams-conversation-ref.js";

const TEAMS_DIRECTORY_MAX_PAGES = 4;

const TEAMS_ROSTER_PAGE_SIZE = 500;

const TEAMS_DIRECTORY_MAX_PER_TEAM = 25;

function log(msg: string): void {
  console.log(`[open-everywhere:teams-directory] ${msg}`);
}

interface TeamsRosterMember {
  id?: unknown;
  name?: unknown;
  givenName?: unknown;
  surname?: unknown;
  email?: unknown;
  userPrincipalName?: unknown;
}

function normalize(raw: string): string {
  return raw.trim().replace(/^@/u, "").replace(/\s+/gu, " ").toLowerCase();
}

export async function fetchTeamsDirectory(query: string): Promise<readonly DirectoryCandidate[]> {
  const q = normalize(query);
  if (q.length === 0) return [];
  const teams = await teamsTeamConversationRefs();
  if (teams.length === 0) return [];

  const perTeam = await Promise.all(teams.map((team) => teamMembersMatching(team, q)));

  const byId = new Map<string, DirectoryCandidate>();
  for (const members of perTeam) {
    for (const member of members) {
      if (!byId.has(member.nativeId)) byId.set(member.nativeId, member);
    }
  }
  return [...byId.values()];
}

async function teamMembersMatching(team: TeamsConversationRef, q: string): Promise<readonly DirectoryCandidate[]> {
  const out: DirectoryCandidate[] = [];
  let continuationToken: string | undefined;
  for (let page = 0; page < TEAMS_DIRECTORY_MAX_PAGES; page++) {
    const body = await rosterPage(team, continuationToken);
    if (!body) return out;
    for (const raw of body.members) {
      const candidate = candidateFromMember(raw, q);
      if (candidate) out.push(candidate);
      if (out.length >= TEAMS_DIRECTORY_MAX_PER_TEAM) return out;
    }
    continuationToken = body.continuationToken;
    if (!continuationToken) return out;
  }
  return out;
}

async function rosterPage(
  team: TeamsConversationRef,
  continuationToken: string | undefined,
): Promise<{ readonly members: readonly TeamsRosterMember[]; readonly continuationToken?: string } | undefined> {
  const params = new URLSearchParams({ pageSize: String(TEAMS_ROSTER_PAGE_SIZE) });
  if (continuationToken) params.set("continuationToken", continuationToken);
  const path = `/v3/conversations/${encodeURIComponent(team.conversationId)}/pagedmembers?${params.toString()}`;
  try {
    const res = await callTeamsConnectorApi({ serviceUrl: team.serviceUrl, path, method: "GET" });
    if (!res.ok) {
      log(`the roster read did not answer (${res.status}) for conversation ${team.conversationId} — the account directory is unavailable there; linking falls back to the code flow.`);
      return undefined;
    }
    const b = res.body as { members?: unknown; continuationToken?: unknown } | null;
    if (!b || typeof b !== "object" || !Array.isArray(b.members)) return undefined;
    return {
      members: b.members as readonly TeamsRosterMember[],
      ...(typeof b.continuationToken === "string" && b.continuationToken.length > 0 ? { continuationToken: b.continuationToken } : {}),
    };
  } catch (err) {
    log(`the roster read failed for conversation ${team.conversationId}: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

function candidateFromMember(member: TeamsRosterMember, q: string): DirectoryCandidate | undefined {
  const nativeId = typeof member.id === "string" ? member.id.trim() : "";
  if (!nativeId.startsWith("29:")) return undefined;
  const name = typeof member.name === "string" ? member.name.trim() : "";
  const upn = typeof member.userPrincipalName === "string" ? member.userPrincipalName.trim() : "";
  const email = typeof member.email === "string" ? member.email.trim() : "";
  const handle = upn || email;
  const matched = normalize(nativeId) === q || [name, handle].some((f) => f.length > 0 && normalize(f).includes(q));
  if (!matched) return undefined;
  return { nativeId, ...(name ? { name } : {}), ...(handle ? { handle } : {}) };
}
