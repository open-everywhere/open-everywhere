import type { TeamsConversationScope, TeamsMessageActivity } from "eve/channels/teams";
import { buildTeamsAuth, teamsMembershipType, teamsMode } from "./teams-identity.js";
import {
  getOperationalStore,
  getThreadEngagement,
  markThreadEngaged,
  resolvePartition,
  roomEngagementAddress,
  shouldDeliverReply,
  type EngagementRow,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";

export function teamsSeamGrant(scope: TeamsConversationScope): string | undefined {
  if (scope === "personal") return undefined;
  return scope === "groupChat" ? "ChatMessage.Read.Chat" : "ChannelMessage.Read.Group";
}

export function teamsSeamUnsupportedReason(scope: TeamsConversationScope): string {
  const grant = teamsSeamGrant(scope) ?? "no RSC grant";
  const room = scope === "groupChat" ? "group-chat" : "channel";
  return (
    `Microsoft delivers non-mention ${room} messages only with the ${grant} RSC grant consented in this tenant; ` +
    `without it a plain follow-up never reaches this deployment, so the engaged seam can wake nothing here`
  );
}

export function teamsMachineAuthored(a: TeamsMessageActivity): boolean {
  const self = a.recipient?.id;
  return (self !== undefined && a.from.id === self) || a.from.role === "bot" || a.from.id.startsWith("28:");
}

export function teamsEngagementAnchor(scope: TeamsConversationScope, conversationId: string | undefined): string | undefined {
  if (!conversationId || conversationId.length === 0) return undefined;
  return teamsMode(scope) === "dm" ? undefined : conversationId;
}

const seamDeliveryProven = new Set<string>();
const seamUnsupportedLogged = new Set<string>();

export function noteTeamsSeamDelivery(scope: TeamsConversationScope): void {
  if (teamsSeamGrant(scope) !== undefined) seamDeliveryProven.add(scope);
}

export function teamsSeamDeliveryProven(scope: TeamsConversationScope): boolean {
  return seamDeliveryProven.has(scope);
}

export function noteTeamsSeamArmed(scope: TeamsConversationScope): boolean {
  if (teamsSeamGrant(scope) === undefined) return false;
  if (seamDeliveryProven.has(scope) || seamUnsupportedLogged.has(scope)) return false;
  seamUnsupportedLogged.add(scope);
  console.warn(`[open-everywhere:teams-engagement] engaged seam armed, delivery UNPROVEN in this process — ${teamsSeamUnsupportedReason(scope)}. One non-mention message from a person, in a conversation this deployment can anchor, would prove the grant present; nothing else this process sees can.`);
  return true;
}

export function resetTeamsSeamSupport(): void {
  seamDeliveryProven.clear();
  seamUnsupportedLogged.clear();
}

export type TeamsEngagementVerdict =
  | { readonly kind: "unanchored"; readonly reason: string }
  | { readonly kind: "engage"; readonly anchor: string; readonly org: string }
  | { readonly kind: "deliver"; readonly anchor: string; readonly reason: string }
  | { readonly kind: "hold"; readonly anchor: string; readonly reason: string; readonly stopped: boolean };

export interface TeamsEngagementDeps {
  readonly getEngagement?: (p: Partition, anchor: string) => Promise<EngagementRow | null>;
  readonly markEngaged?: (p: Partition, anchor: string, atIso: string) => Promise<void>;
  readonly now?: () => string;
}

function teamsSeamPartition(a: TeamsMessageActivity): Partition | null {
  try {
    const auth = buildTeamsAuth({
      userId: a.from.id,
      tenantId: a.tenantId ?? a.conversation.tenantId,
      conversationId: a.conversation.id,
      channelId: a.teamsChannelId,
      teamId: a.teamId,
      scope: a.scope,
      membershipType: teamsMembershipType(a.channelData),
    });
    return resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
  } catch {
    return null;
  }
}

export async function resolveTeamsEngagement(
  a: TeamsMessageActivity,
  machineAuthored: boolean,
  deps: TeamsEngagementDeps = {},
): Promise<TeamsEngagementVerdict> {
  const anchor = teamsEngagementAnchor(a.scope, a.conversation.id);
  if (!anchor) return { kind: "unanchored", reason: "a 1:1 chat carries no engagement anchor — it is answered unconditionally" };
  const partition = teamsSeamPartition(a);
  if (!partition) return { kind: "unanchored", reason: "the activity has no resolvable partition — no row to address" };

  if (a.isBotMentioned) return { kind: "engage", anchor, org: partition.org };

  noteTeamsSeamDelivery(a.scope);

  const read = deps.getEngagement ?? ((p, key) => getThreadEngagement(p, key));
  const row = await read(partition, anchor);
  const decision = shouldDeliverReply({
    isEngaged: row !== null,
    stopped: row?.stopped ?? false,
    authorIsBot: machineAuthored,
    isAppMention: false,
    inThread: true,
  });
  if (decision.deliver) return { kind: "deliver", anchor, reason: decision.reason };
  return { kind: "hold", anchor, reason: decision.reason, stopped: row?.stopped === true };
}

export async function markTeamsEngaged(a: TeamsMessageActivity, deps: TeamsEngagementDeps = {}): Promise<string | null> {
  const anchor = teamsEngagementAnchor(a.scope, a.conversation.id);
  if (!anchor) return null;
  const partition = teamsSeamPartition(a);
  if (!partition) return null;
  const now = deps.now ?? (() => new Date().toISOString());
  const mark =
    deps.markEngaged ?? ((p, key, atIso) => markThreadEngaged(p, key, atIso, { participating: true, engagedBy: a.id }));
  await mark(partition, anchor, now());
  noteTeamsSeamArmed(a.scope);
  return anchor;
}

export async function teamsRoomWatchStopped(partition: Partition): Promise<boolean> {
  const room = roomEngagementAddress(partition);
  try {
    return (await getOperationalStore().getEngagement(room.partition.org, room.partition.surfaceKey, room.anchor))?.stopped === true;
  } catch (err) {
    console.warn(`[open-everywhere:teams-engagement] room stop unreadable for ${room.partition.surfaceKey} — HOLDING the ambient wake (fail-closed): ${String(err)}`);
    return true;
  }
}

export async function markTeamsRoomWatched(partition: Partition, atIso: string): Promise<void> {
  const room = roomEngagementAddress(partition);
  await markThreadEngaged(room.partition, room.anchor, atIso, { participating: false });
}

export async function clearTeamsRoomStop(partition: Partition, atIso: string, engagedBy: string): Promise<void> {
  const room = roomEngagementAddress(partition);
  await markThreadEngaged(room.partition, room.anchor, atIso, { participating: true, engagedBy });
}

export async function teamsEngagedAdmits(a: TeamsMessageActivity, deps: TeamsEngagementDeps = {}): Promise<boolean> {
  if (a.isBotMentioned) return true;
  const verdict = await resolveTeamsEngagement(a, teamsMachineAuthored(a), deps);
  return verdict.kind === "deliver";
}
