import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerSurfaceParity,
  registerProviderEvents,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerSeatCatchUp,
  registerReactionSurface,
  registerSurfaceMessageOps,
  registerCardPoster,
  registerJudgeLiftNoticePoster,
  registerRoutineDispatch,
  registerNativeAdminCheck,
  registerNativeMemberCheck,
  registerScopeLabelResolver,
  registerMeetingInviteResolver,
  registerBotDisplayName,
  registerAccountDirectory,
  registerProviderDocs,
  registerSurfaceCommandReconciler,
  registerFriendlyNameResolver,
  registerAccountDisplayName,
  registerSurfaceCredentialProbe,
  operatorSecretConfigured,
} from "@open-everywhere/core/agent/adapter-api.js";
import { DISCORD_BOT_TOKEN_NAME } from "./channels/discord-credentials.js";
import { fetchDiscordInfo } from "./channels/discord-channel-info.js";
import { discordFriendlyNameResolver } from "./channels/discord-friendly-names.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { DISCORD_SURFACE_PARITY } from "./surface-parity.js";
import { DISCORD_PROVIDER_EVENTS } from "./provider-events.js";
import { registerDiscordOps } from "./ops.js";
import { resolveDiscordTarget, discordReportTargetFor, resolveDiscordDeclaredTarget, discordTestRunArm } from "./channels/discord-dispatch-target.js";
import { bindDiscord } from "./channels/discord-identity.js";
import { discordPostArm } from "./channels/discord-post-arm.js";
import { discordWakeOriginCodec } from "./channels/discord-origin-codec.js";
import { discordReadAdapter } from "./channels/discord-read.js";
import { discordSeatCatchUpFetch, DISCORD_TIMESTAMP_PRECISION_MS } from "./channels/discord-backscroll.js";
import { discordMessageOps } from "./channels/discord-message-ops.js";
import { discordBotDisplayName } from "./channels/discord-bot-name.js";
import { fetchGuildDirectory } from "./channels/discord-directory.js";
import { postDiscordApprovalCard, postDiscordJudgeLiftNotice } from "./approvals/discord-flow.js";
import { discordScopeLabelResolver } from "./approvals/discord-scope-label.js";
import { discordInviteResolver } from "./channels/discord-invite.js";
import { guildIdFromScopeKey, isGuildAdminViaRest, isGuildMemberViaRest } from "./approvals/discord-admin.js";
import { reconcileDiscordCommands } from "./commands/discord-command-sync.js";

export function registerDiscordProvider(): void {
  registerIdentityMapper("discord", bindDiscord);
  registerCapabilityManifest("discord", { midTurnPost: true, reactions: true, closingProseDropped: true });
  registerSurfaceParity("discord", DISCORD_SURFACE_PARITY);
  registerProviderEvents("discord", DISCORD_PROVIDER_EVENTS);
  registerPostArm(discordPostArm);
  registerFriendlyNameResolver("discord", discordFriendlyNameResolver());
  registerAccountDisplayName("discord", async (nativeId) => {
    const info = await fetchDiscordInfo("users", nativeId);
    return info ? { name: info.name, ...(info.handle ? { handle: info.handle } : {}) } : undefined;
  });
  registerWakeOriginCodec("discord", discordWakeOriginCodec);
  registerReadAdapter(discordReadAdapter);
  registerSeatCatchUp("discord", discordSeatCatchUpFetch, { timestampPrecisionMs: DISCORD_TIMESTAMP_PRECISION_MS });
  registerReactionSurface("discord");
  registerSurfaceMessageOps(discordMessageOps);
  registerCardPoster("discord", postDiscordApprovalCard);
  registerJudgeLiftNoticePoster("discord", postDiscordJudgeLiftNotice);
  registerRoutineDispatch("discord", {
    resolveTarget: resolveDiscordTarget,
    reportTargetFor: discordReportTargetFor,
    resolveDeclaredTarget: (spec) => resolveDiscordDeclaredTarget(spec),
    testRun: discordTestRunArm,
  });
  registerNativeAdminCheck("discord", async (scopeKey, principalId) => {
    const guildId = guildIdFromScopeKey(scopeKey);
    return guildId ? isGuildAdminViaRest(guildId, principalId) : false;
  });
  registerNativeMemberCheck("discord", async (scopeKey, principalId) => {
    const guildId = guildIdFromScopeKey(scopeKey);
    return guildId ? isGuildMemberViaRest(guildId, principalId) : false;
  });
  registerScopeLabelResolver("discord", discordScopeLabelResolver);
  registerMeetingInviteResolver("discord", discordInviteResolver);
  registerBotDisplayName("discord", discordBotDisplayName);
  registerAccountDirectory("discord", (query) => fetchGuildDirectory(query));
  registerProviderDocs("discord", PROVIDER_DOCS);
  registerSurfaceCommandReconciler("discord", (scope) => reconcileDiscordCommands(scope));
  registerSurfaceCredentialProbe("discord", () => operatorSecretConfigured(DISCORD_BOT_TOKEN_NAME));
  registerDiscordOps();
}
