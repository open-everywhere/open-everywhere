import { getOperationalStore, deploymentOrg, type ProactiveAddress } from "@open-everywhere/core/agent/adapter-api.js";
import { isTrustedTeamsServiceUrl } from "./teams-origin-codec.js";

export const TEAMS_ADDRESS_PLATFORM = "teams";

export const TEAMS_PERSONAL_ADDRESS_KIND = "personal";

export const TEAMS_TEAM_ADDRESS_KIND = "team";

export const TEAMS_TEAM_ADDRESS_READ_LIMIT = 8;

const TEAMS_REPLY_CHAIN_SUFFIX = ";messageid=";

export function teamsChannelGrainConversationId(conversationId: string): string {
  const i = conversationId.lastIndexOf(TEAMS_REPLY_CHAIN_SUFFIX);
  return i < 0 ? conversationId : conversationId.slice(0, i);
}

export interface TeamsConversationRef {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly tenantId: string;
}

export interface TeamsInboundReference {
  readonly scope?: string;
  readonly tenantId?: string;
  readonly conversationId?: string;
  readonly serviceUrl?: string;
  readonly userId?: string;
  readonly teamId?: string;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function teamsAddressRowsFor(input: TeamsInboundReference, at: Date = new Date()): readonly ProactiveAddress[] {
  const serviceUrl = nonEmpty(input.serviceUrl);
  const tenantId = nonEmpty(input.tenantId);
  const conversationId = nonEmpty(input.conversationId);
  if (!serviceUrl || !tenantId || !conversationId) return [];
  if (!isTrustedTeamsServiceUrl(serviceUrl)) return [];
  const updatedAt = at.toISOString();

  if (input.scope === "personal") {
    const userId = nonEmpty(input.userId);
    if (!userId) return [];
    return [
      {
        platform: TEAMS_ADDRESS_PLATFORM,
        kind: TEAMS_PERSONAL_ADDRESS_KIND,
        refKey: userId,
        tenant: tenantId,
        address: { serviceUrl, conversationId },
        updatedAt,
      },
    ];
  }

  if (input.scope === "channel") {
    const teamId = nonEmpty(input.teamId);
    if (!teamId) return [];
    return [
      {
        platform: TEAMS_ADDRESS_PLATFORM,
        kind: TEAMS_TEAM_ADDRESS_KIND,
        refKey: teamId,
        tenant: tenantId,
        address: { serviceUrl, conversationId: teamsChannelGrainConversationId(conversationId) },
        updatedAt,
      },
    ];
  }

  return [];
}

function log(msg: string): void {
  console.log(`[open-everywhere:teams-address] ${msg}`);
}

export async function recordTeamsConversationReference(input: TeamsInboundReference): Promise<void> {
  try {
    const rows = teamsAddressRowsFor(input);
    if (rows.length === 0) return;
    const org = deploymentOrg();
    const store = getOperationalStore();
    for (const row of rows) await store.recordProactiveAddress(org, row);
  } catch (err) {
    log(`could not record the conversation reference: ${(err as Error)?.message ?? String(err)}`);
  }
}

function refFrom(row: ProactiveAddress | undefined): TeamsConversationRef | undefined {
  if (!row) return undefined;
  const serviceUrl = nonEmpty(row.address["serviceUrl"]);
  const conversationId = nonEmpty(row.address["conversationId"]);
  const tenantId = nonEmpty(row.tenant);
  if (!serviceUrl || !conversationId || !tenantId) return undefined;
  if (!isTrustedTeamsServiceUrl(serviceUrl)) return undefined;
  return { serviceUrl, conversationId, tenantId };
}

export async function teamsPersonalConversationRef(principalId: string): Promise<TeamsConversationRef | undefined> {
  const id = nonEmpty(principalId);
  if (!id) return undefined;
  try {
    const row = await getOperationalStore().proactiveAddress(deploymentOrg(), TEAMS_ADDRESS_PLATFORM, TEAMS_PERSONAL_ADDRESS_KIND, id);
    return refFrom(row);
  } catch (err) {
    log(`could not read the personal conversation reference: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

export async function rememberTeamsPersonalConversation(principalId: string, ref: TeamsConversationRef): Promise<void> {
  await recordTeamsConversationReference({
    scope: "personal",
    userId: principalId,
    tenantId: ref.tenantId,
    conversationId: ref.conversationId,
    serviceUrl: ref.serviceUrl,
  });
}

export async function teamsTeamConversationRefs(): Promise<readonly TeamsConversationRef[]> {
  try {
    const rows = await getOperationalStore().proactiveAddresses(
      deploymentOrg(),
      TEAMS_ADDRESS_PLATFORM,
      TEAMS_TEAM_ADDRESS_KIND,
      TEAMS_TEAM_ADDRESS_READ_LIMIT,
    );
    return rows.map(refFrom).filter((r): r is TeamsConversationRef => r !== undefined);
  } catch (err) {
    log(`could not read the team conversation references: ${(err as Error)?.message ?? String(err)}`);
    return [];
  }
}

export async function teamsSoleTenantRegion(): Promise<{ readonly serviceUrl: string; readonly tenantId: string } | undefined> {
  const refs = await teamsTeamConversationRefs();
  if (refs.length === 0) return undefined;
  const tenants = new Set(refs.map((r) => r.tenantId));
  if (tenants.size !== 1) return undefined;
  const newest = refs[0]!;
  return { serviceUrl: newest.serviceUrl, tenantId: newest.tenantId };
}
