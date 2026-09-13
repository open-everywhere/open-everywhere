import { bridgeSlackForm, type SlackFormFn } from "../channels/slack-bridge.js";
import {
  bridgeTeamsRoomMembership,
  bridgeTeamsAccountActive,
  type TeamsAccountActiveCheck,
  type TeamsMembershipUnresolved,
  type TeamsRoomMembership,
  type TeamsRoomMembershipCheck,
} from "../channels/teams-bridge.js";
import { dmTrustTtlMs } from "../identity/trust.js";
import type { RoutineSkipReason } from "./fire-audit.js";

export type RoomMembershipCheck = (channelId: string, userId: string) => Promise<boolean | undefined>;

export type AccountActiveCheck = (userId: string) => Promise<boolean | undefined>;

const ROOM_MEMBER_MAX_PAGES = 10;

const roomMemberCache = new Map<string, { readonly member: boolean; readonly at: number }>();

export async function slackRoomMembershipViaConversationsMembers(channelId: string, userId: string, form: SlackFormFn): Promise<boolean | undefined> {
  if (channelId.length === 0 || userId.length === 0) return undefined;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < ROOM_MEMBER_MAX_PAGES; page++) {
      const qs = new URLSearchParams({ channel: channelId, limit: "1000" });
      if (cursor) qs.set("cursor", cursor);
      const info = await form("conversations.members", qs.toString());
      if (!info || info["ok"] !== true) return undefined;
      if (!Array.isArray(info["members"])) return undefined;
      const members = info["members"] as unknown[];
      if (members.includes(userId)) return true;
      const meta = info["response_metadata"] as { next_cursor?: unknown } | undefined;
      cursor = typeof meta?.next_cursor === "string" && meta.next_cursor.length > 0 ? meta.next_cursor : undefined;
      if (!cursor) break;
    }
    return cursor ? undefined : false;
  } catch {
    return undefined;
  }
}

export const liveRoomMembership: RoomMembershipCheck = async (channelId, userId) => {
  if (channelId.length === 0 || userId.length === 0) return undefined;
  const key = `${channelId}/${userId}`;
  const hit = roomMemberCache.get(key);
  if (hit && Date.now() - hit.at < dmTrustTtlMs()) return hit.member;
  const member = await slackRoomMembershipViaConversationsMembers(channelId, userId, bridgeSlackForm);
  if (member !== undefined) roomMemberCache.set(key, { member, at: Date.now() });
  return member;
};

const accountActiveCache = new Map<string, { readonly active: boolean; readonly at: number }>();

const liveAccountActive: AccountActiveCheck = async (userId) => {
  if (userId.length === 0) return undefined;
  const hit = accountActiveCache.get(userId);
  if (hit && Date.now() - hit.at < dmTrustTtlMs()) return hit.active;
  try {
    const info = await bridgeSlackForm("users.info", new URLSearchParams({ user: userId }).toString());
    if (!info || info["ok"] !== true) return undefined;
    const u = info["user"] as Record<string, unknown> | undefined;
    if (!u || typeof u !== "object") return undefined;
    const active = !u["deleted"];
    accountActiveCache.set(userId, { active, at: Date.now() });
    return active;
  } catch {
    return undefined;
  }
};

export function _resetFireEligibilityCachesForTest(): void {
  roomMemberCache.clear();
  accountActiveCache.clear();
}

export type { TeamsRoomMembershipCheck, TeamsAccountActiveCheck, TeamsMembershipUnresolved };

const liveTeamsRoomMembership: TeamsRoomMembershipCheck = (teamId, channelId, aadObjectId, serviceUrl) =>
  bridgeTeamsRoomMembership(teamId, channelId, aadObjectId, serviceUrl);

const liveTeamsAccountActive: TeamsAccountActiveCheck = (aadObjectId) => bridgeTeamsAccountActive(aadObjectId);

export interface FireEligibilityInput {
  readonly createdBy: string | undefined;
  readonly platform: string | undefined;
  readonly roomId: string | undefined;
  readonly membershipCheck?: RoomMembershipCheck;
  readonly activeCheck?: AccountActiveCheck;
  readonly teamsTeamId?: string;
  readonly teamsCreatorAadObjectId?: string;
  readonly teamsServiceUrl?: string;
  readonly teamsMembershipCheck?: TeamsRoomMembershipCheck;
  readonly teamsActiveCheck?: TeamsAccountActiveCheck;
}

export type FireEligibility =
  | {
      readonly eligible: true;
      readonly teamsMembershipUnresolved?: TeamsMembershipUnresolved;
    }
  | { readonly eligible: false; readonly reason: RoutineSkipReason };

function verdictFromChecks(member: boolean | undefined, active: boolean | undefined): FireEligibility {
  if (member === false) return { eligible: false, reason: "creator_removed_from_room" };
  if (active === false) return { eligible: false, reason: "creator_account_inactive" };
  return { eligible: true };
}

export async function checkFireEligibility(input: FireEligibilityInput): Promise<FireEligibility> {
  if (!input.createdBy) return { eligible: true };
  if (input.platform === "slack") {
    if (!input.roomId) return { eligible: true };
    const membershipCheck = input.membershipCheck ?? liveRoomMembership;
    const activeCheck = input.activeCheck ?? liveAccountActive;
    const [member, active] = await Promise.all([
      membershipCheck(input.roomId, input.createdBy).catch((): boolean | undefined => undefined),
      activeCheck(input.createdBy).catch((): boolean | undefined => undefined),
    ]);
    return verdictFromChecks(member, active);
  }
  if (input.platform === "teams") {
    if (!input.roomId) return { eligible: true };
    if (!input.teamsTeamId || !input.teamsCreatorAadObjectId) return { eligible: true, teamsMembershipUnresolved: "missing_ids" };
    const membershipCheck = input.teamsMembershipCheck ?? liveTeamsRoomMembership;
    const activeCheck = input.teamsActiveCheck ?? liveTeamsAccountActive;
    const [membership, active] = await Promise.all([
      membershipCheck(input.teamsTeamId, input.roomId, input.teamsCreatorAadObjectId, input.teamsServiceUrl).catch(
        (): TeamsRoomMembership => ({ member: undefined, unresolved: "read_error" }),
      ),
      activeCheck(input.teamsCreatorAadObjectId).catch((): boolean | undefined => undefined),
    ]);
    const verdict = verdictFromChecks(membership.member, active);
    if (verdict.eligible && membership.member === undefined) {
      return { eligible: true, teamsMembershipUnresolved: membership.unresolved };
    }
    return verdict;
  }
  return { eligible: true };
}
