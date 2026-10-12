import type { TeamsConversationUpdateActivity, TeamsMessageActivity } from "eve/channels/teams";
import {
  isSurfaceOnboarded,
  markSurfaceOnboarded,
  introMessage,
  resolvePartition,
  domainKeyOf,
  getConfig,
  resolveExternalPolicy,
  externalPolicyOverrideFor,
  roomIsSilenced,
  RateLimitExhaustedError,
  appendAudit,
  getOperationalStore,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth, teamsMembershipType, teamsTrustGroup } from "./teams-identity.js";
import { teamsChannelGrainConversationId } from "./teams-conversation-ref.js";
import { sendTeamsActivityBackedOff } from "./teams-connector.js";
import { teamsBotDisplayName } from "./teams-bot-name.js";

function log(msg: string): void {
  console.log(`[open-everywhere:teams-intro] ${msg}`);
}

export interface TeamsIntroTarget {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly tenantId?: string;
  readonly teamId?: string;
  readonly teamsChannelId?: string;
  readonly scope: string;
  readonly membershipType?: string;
  readonly botName?: string;
}

export type TeamsBotAddedUpdate = TeamsIntroTarget;

export type TeamsIntroOutcome = { readonly posted: true } | { readonly posted: false; readonly reason: string };

export function parseTeamsBotAdded(activity: TeamsConversationUpdateActivity): TeamsBotAddedUpdate | null {
  const botId = activity.recipient?.id;
  const added = (activity.raw as { membersAdded?: unknown }).membersAdded;
  if (!botId || !Array.isArray(added)) return null;
  const addsBot = added.some((m) => typeof m === "object" && m !== null && (m as { id?: unknown }).id === botId);
  if (!addsBot) return null;
  const scope = activity.conversation.conversationType ?? (activity.conversation.isGroup === true ? "groupChat" : activity.conversation.isGroup === false ? "personal" : "unknown");
  const membershipType = teamsMembershipType(activity.channelData);
  const botName = activity.recipient.name?.trim();
  return {
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
    ...(activity.tenantId ?? activity.conversation.tenantId ? { tenantId: activity.tenantId ?? activity.conversation.tenantId } : {}),
    ...(activity.teamId ? { teamId: activity.teamId } : {}),
    ...(activity.teamsChannelId ? { teamsChannelId: activity.teamsChannelId } : {}),
    scope,
    ...(membershipType ? { membershipType } : {}),
    ...(botName ? { botName } : {}),
  };
}

export function teamsFirstContactTarget(a: TeamsMessageActivity): TeamsIntroTarget | null {
  if (a.scope !== "channel" || a.isBotMentioned !== true) return null;
  const membershipType = teamsMembershipType(a.channelData);
  const botName = a.recipient?.name?.trim();
  return {
    serviceUrl: a.serviceUrl,
    conversationId: teamsChannelGrainConversationId(a.conversation.id),
    ...(a.tenantId ?? a.conversation.tenantId ? { tenantId: a.tenantId ?? a.conversation.tenantId } : {}),
    ...(a.teamId ? { teamId: a.teamId } : {}),
    ...(a.teamsChannelId ? { teamsChannelId: a.teamsChannelId } : {}),
    scope: a.scope,
    ...(membershipType ? { membershipType } : {}),
    ...(botName ? { botName } : {}),
  };
}

export function teamsIntroPartition(t: TeamsIntroTarget): Partition {
  const channelConversation = teamsChannelGrainConversationId(t.conversationId);
  const auth = buildTeamsAuth({
    userId: "",
    tenantId: t.tenantId,
    conversationId: channelConversation,
    channelId: t.teamsChannelId,
    teamId: t.teamId,
    serviceUrl: t.serviceUrl,
    scope: t.scope,
    membershipType: t.membershipType,
  });
  return resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
}

function introRoomSilenced(t: TeamsIntroTarget, p: Partition): boolean {
  const roomKey = domainKeyOf(p);
  let policy;
  try {
    policy = resolveExternalPolicy(externalPolicyOverrideFor(roomKey, getConfig().loadDomains()));
  } catch {
    policy = resolveExternalPolicy();
  }
  const group = teamsTrustGroup(t.teamId);
  const groupKey = group && t.tenantId ? `teams/${t.tenantId}/${group.trustGroup}` : undefined;
  return roomIsSilenced(
    { room: { surfaceKey: roomKey, ...(groupKey ? { groupKey } : {}) }, ...(t.membershipType === "shared" ? { vendorExternal: true } : {}) },
    policy,
  );
}

export interface TeamsIntroDeps {
  readonly isOnboarded?: (p: Partition) => Promise<boolean>;
  readonly markOnboarded?: (p: Partition) => Promise<void>;
  readonly send?: (input: { readonly serviceUrl: string; readonly conversationId: string; readonly body: unknown }) => Promise<unknown>;
  readonly botName?: () => Promise<string | undefined>;
  readonly silenced?: (t: TeamsIntroTarget, p: Partition) => boolean;
  readonly audit?: typeof appendAudit;
  readonly claim?: (org: string, key: string, atIso: string) => Promise<boolean>;
}

const INTRO_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export type TeamsIntroDoor = "join" | "first-contact";

export async function teamsChannelIntro(t: TeamsIntroTarget, door: TeamsIntroDoor, deps: TeamsIntroDeps = {}): Promise<TeamsIntroOutcome> {
  try {
    if (t.scope !== "channel") return { posted: false, reason: "only a team channel gets an intro — a personal or group chat does not" };
    if (t.membershipType === "shared") return { posted: false, reason: "a shared channel can hold people from other tenants" };
    let p: Partition;
    try {
      p = teamsIntroPartition(t);
    } catch {
      return { posted: false, reason: "the channel's partition did not resolve" };
    }
    if ((deps.silenced ?? introRoomSilenced)(t, p)) return { posted: false, reason: "the external-participant policy silences this room" };
    if (await (deps.isOnboarded ?? isSurfaceOnboarded)(p)) return { posted: false, reason: "this channel was already introduced" };
    let won: boolean;
    try {
      const claim = deps.claim ?? ((org: string, key: string, atIso: string) => getOperationalStore().markEventSeen(org, key, atIso, INTRO_CLAIM_TTL_MS));
      won = await claim(p.org, `teams-intro:${p.surfaceKey}`, new Date().toISOString());
    } catch (err) {
      log(`intro claim failed (${p.surfaceKey}): ${String(err)}`);
      return { posted: false, reason: "the atomic intro claim could not be taken" };
    }
    if (!won) return { posted: false, reason: "another delivery holds the intro claim" };
    try {
      await (deps.markOnboarded ?? markSurfaceOnboarded)(p);
    } catch (err) {
      log(`onboarded marker write failed (${p.surfaceKey}): ${String(err)}`);
      return { posted: false, reason: "the once-only marker could not be claimed" };
    }
    const name = t.botName ?? (await (deps.botName ?? teamsBotDisplayName)());
    await (deps.send ?? sendTeamsActivityBackedOff)({
      serviceUrl: t.serviceUrl,
      conversationId: t.conversationId,
      body: { type: "message", text: introMessage(false, name) },
    });
    await (deps.audit ?? appendAudit)({
      org: p.org,
      platform: "teams",
      workspace: p.workspace,
      surface: p.surfaceKey,
      action: "teams.intro_posted",
      detail: { door, conversationId: t.conversationId },
    }).catch(() => undefined);
    return { posted: true };
  } catch (err) {
    if (err instanceof RateLimitExhaustedError) {
      console.warn(`[open-everywhere:teams] rate limited: the channel intro gave up after ${err.attempts} attempts (waited ${err.waitedMs} ms)`);
    }
    return { posted: false, reason: `the intro failed: ${String(err instanceof Error ? err.message : err)}` };
  }
}

export function liveTeamsChannelIntro(update: TeamsBotAddedUpdate): Promise<TeamsIntroOutcome> {
  return teamsChannelIntro(update, "join");
}

export function liveTeamsFirstContactIntro(a: TeamsMessageActivity): Promise<TeamsIntroOutcome> {
  const target = teamsFirstContactTarget(a);
  return target ? teamsChannelIntro(target, "first-contact") : Promise.resolve({ posted: false, reason: "not a channel @mention" });
}
