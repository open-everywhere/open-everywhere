import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerRoutineDispatch,
  type DispatchTarget,
  type Routine,
} from "@open-everywhere/core/agent/adapter-api.js";
import teamsChannel from "./channels/teams.js";
import { bindTeams, teamsMode } from "./channels/teams-identity.js";
import { teamsPostArm } from "./channels/teams-post-arm.js";
import { teamsWakeOriginCodec } from "./channels/teams-origin-codec.js";
import { teamsReadAdapter } from "./channels/teams-read.js";

function storedString(t: Routine["target"], key: string): string | undefined {
  const v = t?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function resolveTeamsTarget(r: Routine): DispatchTarget | null {
  const serviceUrl = storedString(r.target, "serviceUrl");
  const conversationId = storedString(r.target, "conversationId");
  if (!serviceUrl || !conversationId) return null;
  const conversationType = storedString(r.target, "conversationType");
  const channelId = storedString(r.target, "channelId");
  const teamId = storedString(r.target, "teamId");
  const tenantId = storedString(r.target, "tenantId") ?? r.surfaceKey.split("/")[1] ?? "";
  const mode = teamsMode(conversationType);
  return {
    channel: teamsChannel,
    target: {
      serviceUrl,
      conversationId,
      ...(conversationType ? { conversationType } : {}),
      ...(channelId ? { channelId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(tenantId ? { tenantId } : {}),
    },
    mode,
    attributes: {
      conversation_id: conversationId,
      service_url: serviceUrl,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      ...(channelId ? { channel_id: channelId } : {}),
      ...(teamId ? { team_id: teamId } : {}),
      ...(conversationType ? { scope: conversationType } : {}),
    },
  };
}

export function registerTeamsProvider(): void {
  registerIdentityMapper("teams", bindTeams);
  registerCapabilityManifest("teams", { midTurnPost: true, reactions: false });
  registerPostArm(teamsPostArm);
  registerWakeOriginCodec("teams", teamsWakeOriginCodec);
  registerReadAdapter(teamsReadAdapter);
  registerRoutineDispatch("teams", { resolveTarget: resolveTeamsTarget });
}
