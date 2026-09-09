import { bridgePartnerFactsFromInfo, bridgeSlackForm } from "../channels/slack-bridge.js";
import type { SessionMode } from "../access/resolver.js";

export type CreatorStandingCheck = (principalId: string, workspaceId?: string) => Promise<boolean>;

const liveCreatorStanding: CreatorStandingCheck = async (principalId, workspaceId) => {
  try {
    const info = await bridgeSlackForm("users.info", new URLSearchParams({ user: principalId }).toString());
    if (!info) return false;
    return bridgePartnerFactsFromInfo(info, workspaceId).dmPartnerTrust === "internal";
  } catch {
    return false;
  }
};

export async function recheckFireCreator(input: {
  readonly createdBy: string | undefined;
  readonly platform: string | undefined;
  readonly mode: SessionMode;
  readonly workspaceId?: string;
  readonly check?: CreatorStandingCheck;
}): Promise<boolean | undefined> {
  if (!input.createdBy) return undefined;
  if (input.mode !== "dm") return undefined;
  if (input.platform !== "slack") return undefined;
  const check = input.check ?? liveCreatorStanding;
  return check(input.createdBy, input.workspaceId);
}
