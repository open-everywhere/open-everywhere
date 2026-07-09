import { linearChannel, callLinearGraphQL, type LinearApiOptions, type LinearChannelCredentials } from "eve/channels/linear";
import { buildLinearAuth, teamFactsFromTeam } from "./linear-identity.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}
function teamIdFromRaw(raw: unknown): string | undefined {
  for (const base of [pick(raw, "agentSession"), pick(raw, "data"), raw]) {
    const id = str(pick(pick(pick(base, "issue"), "team"), "id"));
    if (id) return id;
  }
  return undefined;
}

export async function enrichTeamPrivacy(
  teamId: string | undefined,
  opts?: { readonly api?: LinearApiOptions; readonly credentials?: LinearChannelCredentials },
): Promise<boolean | undefined> {
  if (!teamId) return undefined;
  try {
    const data = await callLinearGraphQL<{ team?: { private?: boolean } }>({
      api: opts?.api,
      credentials: opts?.credentials,
      query: "query TeamPrivacy($id: String!) { team(id: $id) { private } }",
      queryName: "TeamPrivacy",
      variables: { id: teamId },
    });
    return teamFactsFromTeam(data).isPrivate;
  } catch {
    return undefined;
  }
}

export default linearChannel({
  onAgentSession: async (_ctx, event) => {
    const s = event.agentSession;
    const agentSessionId = s.id;
    if (!agentSessionId) return null;

    const teamId = teamIdFromRaw(event.raw);
    const isPrivate = await enrichTeamPrivacy(teamId);

    const auth = buildLinearAuth({
      agentSessionId,
      organizationId: event.organizationId ?? s.organizationId ?? undefined,
      teamId,
      issueId: s.issueId ?? s.issue?.id ?? undefined,
      issueIdentifier: s.issue?.identifier ?? undefined,
      principalId: s.creator?.id ?? s.creatorId ?? event.appUserId ?? undefined,
      isPrivate,
    });
    return { auth };
  },
});
