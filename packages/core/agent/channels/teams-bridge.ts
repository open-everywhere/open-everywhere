import { processRegistrySlot } from "../lib/process-registry.js";

export type TeamsMembershipUnresolved =
  | "no_provider"
  | "missing_ids"
  | "team_id_unresolved"
  | "read_error"
  | "malformed_response"
  | "roster_incomplete";

export type TeamsRoomMembership =
  | { readonly member: boolean }
  | { readonly member: undefined; readonly unresolved: TeamsMembershipUnresolved };

export type TeamsRoomMembershipCheck = (
  teamId: string,
  channelId: string,
  aadObjectId: string,
  serviceUrl: string | undefined,
) => Promise<TeamsRoomMembership>;

export type TeamsAccountActiveCheck = (aadObjectId: string) => Promise<boolean | undefined>;

export interface TeamsBridge {
  readonly roomMembership: TeamsRoomMembershipCheck;
  readonly accountActive: TeamsAccountActiveCheck;
}

const bridgeSlot = processRegistrySlot<TeamsBridge>("teams-bridge.v1");

export function registerTeamsBridge(b: TeamsBridge): void {
  bridgeSlot.set(b);
}

export function _resetTeamsBridgeForTest(): void {
  bridgeSlot.set(null);
}

export function teamsBridge(): TeamsBridge | null {
  return bridgeSlot.get();
}

export const bridgeTeamsRoomMembership: TeamsRoomMembershipCheck = async (teamId, channelId, aadObjectId, serviceUrl) => {
  const b = bridgeSlot.get();
  return b ? b.roomMembership(teamId, channelId, aadObjectId, serviceUrl) : { member: undefined, unresolved: "no_provider" };
};

export const bridgeTeamsAccountActive: TeamsAccountActiveCheck = async (aadObjectId) =>
  bridgeSlot.get() ? bridgeSlot.get()!.accountActive(aadObjectId) : undefined;
