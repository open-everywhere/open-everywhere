import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerReactionSurface,
  registerSurfaceMessageOps,
  registerCardPoster,
  registerRoutineDispatch,
  registerNativeAdminCheck,
  registerScopeLabelResolver,
  registerProviderDocs,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { resolveDiscordTarget } from "./channels/discord-dispatch-target.js";
import { bindDiscord } from "./channels/discord-identity.js";
import { discordPostArm } from "./channels/discord-post-arm.js";
import { discordWakeOriginCodec } from "./channels/discord-origin-codec.js";
import { discordReadAdapter } from "./channels/discord-read.js";
import { discordMessageOps } from "./channels/discord-message-ops.js";
import { postDiscordApprovalCard } from "./approvals/discord-flow.js";
import { discordScopeLabelResolver } from "./approvals/discord-scope-label.js";
import { guildIdFromScopeKey, isGuildAdminViaRest } from "./approvals/discord-admin.js";

export function registerDiscordProvider(): void {
  registerIdentityMapper("discord", bindDiscord);
  registerCapabilityManifest("discord", { midTurnPost: true, reactions: false });
  registerPostArm(discordPostArm);
  registerWakeOriginCodec("discord", discordWakeOriginCodec);
  registerReadAdapter(discordReadAdapter);
  registerReactionSurface("discord");
  registerSurfaceMessageOps(discordMessageOps);
  registerCardPoster("discord", postDiscordApprovalCard);
  registerRoutineDispatch("discord", { resolveTarget: resolveDiscordTarget });
  registerNativeAdminCheck("discord", async (scopeKey, principalId) => {
    const guildId = guildIdFromScopeKey(scopeKey);
    return guildId ? isGuildAdminViaRest(guildId, principalId) : false;
  });
  registerScopeLabelResolver("discord", discordScopeLabelResolver);
  registerProviderDocs("discord", PROVIDER_DOCS);
}
