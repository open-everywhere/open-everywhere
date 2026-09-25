import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerSurfaceParity,
  registerProviderEvents,
  registerReactionSurface,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerSeatCatchUp,
  registerRoutineDispatch,
  registerTeamsBridge,
  registerBotDisplayName,
  registerAccountDirectory,
  registerSurfaceMessageOps,
  type DispatchTarget,
  type Routine,
  type UnifiedWakeOrigin,
  registerProviderDocs,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { TEAMS_SURFACE_PARITY } from "./surface-parity.js";
import { TEAMS_PROVIDER_EVENTS } from "./provider-events.js";
import { registerTeamsOps } from "./ops.js";
import { teamsMessageOps } from "./channels/teams-message-ops.js";
import teamsChannel from "./channels/teams.js";
import { bindTeams, teamsMode } from "./channels/teams-identity.js";
import { teamsPostArm } from "./channels/teams-post-arm.js";
import { teamsWakeOriginCodec } from "./channels/teams-origin-codec.js";
import { teamsReadAdapter } from "./channels/teams-read.js";
import { teamsSeatCatchUpFetch, TEAMS_TIMESTAMP_PRECISION_MS } from "./channels/teams-catch-up.js";
import { liveTeamsRoomMembership, liveTeamsAccountActive } from "./channels/teams-fire-eligibility.js";
import { teamsBotDisplayName } from "./channels/teams-bot-name.js";
import { fetchTeamsDirectory } from "./channels/teams-directory.js";

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
  const aadObjectId = storedString(r.target, "aadObjectId");
  const tenantId = storedString(r.target, "tenantId") ?? r.surfaceKey.split("/")[1] ?? "";
  const mode = teamsMode(conversationType);
  const origin: UnifiedWakeOrigin = { platform: "teams", serviceUrl, conversationId, ...(tenantId ? { tenantId } : {}) };
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
      ...(aadObjectId ? { aad_object_id: aadObjectId } : {}),
    },
    origin,
  };
}

export function registerTeamsProvider(): void {
  registerIdentityMapper("teams", bindTeams);
  registerCapabilityManifest("teams", { midTurnPost: true, reactions: false, closingProseDropped: true });
  registerSurfaceParity("teams", TEAMS_SURFACE_PARITY);
  registerProviderEvents("teams", TEAMS_PROVIDER_EVENTS);
  registerPostArm(teamsPostArm);
  registerWakeOriginCodec("teams", teamsWakeOriginCodec);
  registerReadAdapter(teamsReadAdapter);
  registerSeatCatchUp("teams", teamsSeatCatchUpFetch, { timestampPrecisionMs: TEAMS_TIMESTAMP_PRECISION_MS });
  registerRoutineDispatch("teams", { resolveTarget: resolveTeamsTarget });
  registerTeamsBridge({ roomMembership: liveTeamsRoomMembership, accountActive: liveTeamsAccountActive });
  registerBotDisplayName("teams", teamsBotDisplayName);
  registerAccountDirectory("teams", (query) => fetchTeamsDirectory(query));
  registerSurfaceMessageOps(teamsMessageOps);
  registerReactionSurface("teams");
  registerProviderDocs("teams", PROVIDER_DOCS);
  registerTeamsOps();
}
