import { type DirectoryCandidate, type FriendlyName } from "@open-everywhere/core/agent/adapter-api.js";
import { callTeamsConnectorApi } from "eve/channels/teams";
import { teamsAppCredentials } from "./teams-connector.js";
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
    const res = await callTeamsConnectorApi({ serviceUrl: team.serviceUrl, path, method: "GET", credentials: teamsAppCredentials() });
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

const TEAMS_NAME_MAX_TEAMS = 3;

export interface TeamsNameDeps {
  readonly call?: (input: { readonly serviceUrl: string; readonly path: string; readonly method: "GET" }) => Promise<{ readonly ok: boolean; readonly body: unknown }>;
  readonly teams?: () => Promise<readonly TeamsConversationRef[]>;
}

const teamsNameCache = new Map<string, Promise<FriendlyName | undefined>>();

export function teamsFriendlyName(id: string, deps: TeamsNameDeps = {}): Promise<FriendlyName | undefined> {
  let p = teamsNameCache.get(id);
  if (!p) {
    p = lookUpTeamsName(id, deps).catch(() => undefined);
    const settled = p;
    void settled.then((hit) => {
      if (hit === undefined && teamsNameCache.get(id) === settled) teamsNameCache.delete(id);
    });
    teamsNameCache.set(id, p);
    while (teamsNameCache.size > TEAMS_NAME_CACHE_MAX) {
      const oldest = teamsNameCache.keys().next().value;
      if (oldest === undefined) break;
      teamsNameCache.delete(oldest);
    }
  }
  return p;
}

const TEAMS_NAME_CACHE_MAX = 2000;

async function lookUpTeamsName(id: string, deps: TeamsNameDeps): Promise<FriendlyName | undefined> {
  const call = deps.call ?? ((input) => callTeamsConnectorApi({ ...input, credentials: teamsAppCredentials() }));
  const teams = (await (deps.teams ?? teamsTeamConversationRefs)()).slice(0, TEAMS_NAME_MAX_TEAMS);
  const isConversation = /^19:/.test(id);
  for (const team of teams) {
    try {
      if (isConversation) {
        const res = await call({ serviceUrl: team.serviceUrl, path: `/v3/teams/${encodeURIComponent(team.conversationId)}/conversations`, method: "GET" });
        const list = res.ok ? (res.body as { conversations?: unknown } | null)?.conversations : undefined;
        if (!Array.isArray(list)) continue;
        const hit = (list as Array<{ id?: unknown; name?: unknown }>).find((c) => c.id === id);
        if (hit) return { label: `#${typeof hit.name === "string" && hit.name.trim() ? hit.name.trim() : "General"}`, kind: "channel" };
      } else {
        const res = await call({ serviceUrl: team.serviceUrl, path: `/v3/conversations/${encodeURIComponent(team.conversationId)}/members/${encodeURIComponent(id)}`, method: "GET" });
        const name = res.ok ? (res.body as { name?: unknown } | null)?.name : undefined;
        if (typeof name === "string" && name.trim()) return { label: name.trim(), kind: "person" };
      }
    } catch {
    }
  }
  return undefined;
}

export async function teamsAccountProfile(id: string, deps: TeamsNameDeps = {}): Promise<{ name?: string; email?: string } | undefined> {
  const call = deps.call ?? ((input) => callTeamsConnectorApi({ ...input, credentials: teamsAppCredentials() }));
  const teams = (await (deps.teams ?? teamsTeamConversationRefs)().catch(() => [])).slice(0, TEAMS_NAME_MAX_TEAMS);
  for (const team of teams) {
    try {
      const res = await call({ serviceUrl: team.serviceUrl, path: `/v3/conversations/${encodeURIComponent(team.conversationId)}/members/${encodeURIComponent(id)}`, method: "GET" });
      const body = res.ok ? (res.body as TeamsRosterMember | null) : null;
      if (!body) continue;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
      const upn = typeof body.userPrincipalName === "string" && body.userPrincipalName.trim() ? body.userPrincipalName.trim() : undefined;
      const mail = typeof body.email === "string" && body.email.trim() ? body.email.trim() : undefined;
      const email = upn ?? mail;
      if (name || email) return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
    } catch {
    }
  }
  return undefined;
}
