import { processRegistrySlot } from "../lib/process-registry.js";

export type TeamsRoomMembershipCheck = (teamId: string, channelId: string, aadObjectId: string) => Promise<boolean | undefined>;

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

export const bridgeTeamsRoomMembership: TeamsRoomMembershipCheck = async (teamId, channelId, aadObjectId) =>
  bridgeSlot.get() ? bridgeSlot.get()!.roomMembership(teamId, channelId, aadObjectId) : undefined;

export const bridgeTeamsAccountActive: TeamsAccountActiveCheck = async (aadObjectId) =>
  bridgeSlot.get() ? bridgeSlot.get()!.accountActive(aadObjectId) : undefined;
