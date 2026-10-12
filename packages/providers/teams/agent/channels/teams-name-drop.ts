import type { TeamsMessageActivity } from "eve/channels/teams";
import {
  nameDropPattern,
  wakeNameDropTokens,
  nameDropWakeEnabled,
  auditNameDropWoke,
  auditNameDropSilent,
  domainKeyOf,
  getConfig,
  resolvePartition,
  type Domain,
  type NameDropAuditKey,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { teamsEngagedAdmits, teamsMachineAuthored } from "./teams-engagement.js";
import { teamsBotDisplayName } from "./teams-bot-name.js";
import { buildTeamsAuth, teamsMembershipType } from "./teams-identity.js";

export interface TeamsNameDropCandidateInput {
  readonly scope: string;
  readonly isBotMentioned: boolean;
  readonly machineAuthored: boolean;
  readonly text: string;
  readonly botName?: string;
}

export function teamsNameDropCandidate(input: TeamsNameDropCandidateInput): boolean {
  if (input.isBotMentioned || input.machineAuthored) return false;
  if (input.scope !== "channel") return false;
  if (!input.botName) return false;
  return wakeNameDropTokens(input.botName).some((token) => nameDropPattern(token).test(input.text));
}

async function teamsBotNameForActivity(a: TeamsMessageActivity): Promise<string | undefined> {
  const relayed = a.recipient?.name?.trim();
  if (relayed) return relayed;
  return await teamsBotDisplayName();
}

export interface TeamsNameDropDeps {
  readonly botName?: (a: TeamsMessageActivity) => Promise<string | undefined>;
  readonly domains?: () => readonly Domain[];
  readonly woke?: typeof auditNameDropWoke;
  readonly silent?: typeof auditNameDropSilent;
}

function teamsNameDropAuditKey(a: TeamsMessageActivity, partition: Partition): NameDropAuditKey {
  return {
    org: partition.org,
    platform: partition.platform,
    workspace: partition.workspace,
    surface: domainKeyOf(partition),
    principalId: a.from.id,
    container: a.conversation.id,
    ts: a.id || null,
  };
}

export async function resolveTeamsNameDrop(
  a: TeamsMessageActivity,
  partition: Partition,
  road: "seat" | "native",
  deps: TeamsNameDropDeps = {},
): Promise<boolean> {
  try {
    const machineAuthored = teamsMachineAuthored(a);
    if (a.isBotMentioned || machineAuthored || a.scope !== "channel") return false;
    const botName = await (deps.botName ?? teamsBotNameForActivity)(a);
    const candidate = teamsNameDropCandidate({ scope: a.scope, isBotMentioned: a.isBotMentioned, machineAuthored, text: a.text, ...(botName ? { botName } : {}) });
    if (!candidate) return false;
    const enabled = nameDropWakeEnabled(domainKeyOf(partition), (deps.domains ?? (() => getConfig().loadDomains()))());
    const key = teamsNameDropAuditKey(a, partition);
    if (!enabled) {
      await (deps.silent ?? auditNameDropSilent)(key, "nameDropWake not enabled for this channel's domain");
      return false;
    }
    await (deps.woke ?? auditNameDropWoke)(key, "name-dropped in an enabled Teams channel — judged wake", { road, via: "built-in" });
    return true;
  } catch {
    return false;
  }
}

export interface TeamsNativeAdmitDeps {
  readonly engaged?: (a: TeamsMessageActivity) => Promise<boolean>;
  readonly nameDrop?: (a: TeamsMessageActivity) => Promise<boolean>;
}

function nativePartition(a: TeamsMessageActivity): Partition | undefined {
  try {
    const auth = buildTeamsAuth({
      userId: a.from.id,
      aadObjectId: a.from.aadObjectId,
      userName: a.from.name,
      tenantId: a.tenantId ?? a.conversation.tenantId,
      conversationId: a.conversation.id,
      channelId: a.teamsChannelId,
      teamId: a.teamId,
      serviceUrl: a.serviceUrl,
      scope: a.scope,
      membershipType: teamsMembershipType(a.channelData),
    });
    return resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
  } catch {
    return undefined;
  }
}

async function liveNativeNameDrop(a: TeamsMessageActivity): Promise<boolean> {
  const partition = nativePartition(a);
  return partition ? await resolveTeamsNameDrop(a, partition, "native") : false;
}

export async function teamsNativeAdmits(a: TeamsMessageActivity, deps: TeamsNativeAdmitDeps = {}): Promise<boolean> {
  if (a.scope === "personal" || a.isBotMentioned) return true;
  if (await (deps.engaged ?? teamsEngagedAdmits)(a)) return true;
  return await (deps.nameDrop ?? liveNativeNameDrop)(a);
}
