import { getOperationalStore, deploymentOrg, surfaceKeySegment, type ProactiveAddress } from "@open-everywhere/core/agent/adapter-api.js";

export const TEAMS_CONVERSATION_KEY_KIND = "conversation-key";

export const TEAMS_PERSON_KEY_KIND = "person-key";

export type TeamsIdIndexKind = typeof TEAMS_CONVERSATION_KEY_KIND | typeof TEAMS_PERSON_KEY_KIND;

const RAW_ID_FIELD = "rawId";

export function teamsIdIndexRow(kind: TeamsIdIndexKind, rawId: string, tenantId: string, updatedAt: string): ProactiveAddress | undefined {
  const id = rawId.trim();
  const spelling = surfaceKeySegment(id);
  if (spelling.length === 0 || spelling === id) return undefined;
  return {
    platform: "teams",
    kind,
    refKey: spelling,
    tenant: tenantId,
    address: { [RAW_ID_FIELD]: id },
    updatedAt,
  };
}

async function restoreTeamsId(kind: TeamsIdIndexKind, id: string): Promise<string> {
  const given = id.trim();
  if (given.length === 0) return id;
  if (surfaceKeySegment(given) !== given) return given;
  try {
    const row = await getOperationalStore().proactiveAddress(deploymentOrg(), "teams", kind, given);
    const raw = row?.address[RAW_ID_FIELD];
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : given;
  } catch (err) {
    console.log(`[open-everywhere:teams-id-restore] could not read the ${kind} index: ${(err as Error)?.message ?? String(err)}`);
    return given;
  }
}

export function restoreTeamsConversationId(id: string): Promise<string> {
  return restoreTeamsId(TEAMS_CONVERSATION_KEY_KIND, id);
}

export function restoreTeamsPersonId(id: string): Promise<string> {
  return restoreTeamsId(TEAMS_PERSON_KEY_KIND, id);
}
