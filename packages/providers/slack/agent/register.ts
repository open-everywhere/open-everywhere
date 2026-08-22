import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerReactionSurface,
  registerBotDisplayName,
  registerAccountDisplayName,
  registerAccountDirectory,
  registerSlackBridge,
  registerProviderDocs,
  registerWebhookVerifier,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { bindSlack, partnerFactsFromInfo } from "./channels/slack-identity.js";
import { slackPostArm } from "./channels/slack-post-arm.js";
import { slackWakeOriginCodec } from "./channels/slack-origin-codec.js";
import { slackReadAdapter, callSlackRead } from "./channels/slack-read.js";
import { registerSlackAttachmentResolver } from "./channels/slack-attachments.js";
import {
  slackForm,
  fetchUserDisplayName,
  fetchChannelDisplayName,
  fetchUserProfileNames,
  fetchWorkspaceRoster,
  botDisplayName,
  confirmChannelInternal,
  registerSlackGovernanceMembers,
} from "./channels/slack-events.js";
import slackChannel from "./channels/slack.js";
import { slackWebhookVerifier } from "./channels/slack-webhook-verifier.js";
import { registerSlackOps } from "./ops.js";

export function registerSlackProvider(): void {
  registerIdentityMapper("slack", bindSlack);
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  registerPostArm(slackPostArm);
  registerWakeOriginCodec("slack", slackWakeOriginCodec);
  registerReadAdapter(slackReadAdapter);
  registerReactionSurface("slack");
  registerBotDisplayName("slack", botDisplayName);
  registerAccountDisplayName("slack", (nativeId) => fetchUserProfileNames(nativeId));
  registerAccountDirectory("slack", () => fetchWorkspaceRoster());
  registerSlackAttachmentResolver();
  registerSlackGovernanceMembers();
  registerSlackBridge({
    form: slackForm,
    readCall: callSlackRead,
    fetchUserDisplayName,
    fetchChannelDisplayName,
    botDisplayName,
    confirmChannelInternal,
    partnerFactsFromInfo,
    channel: slackChannel,
  });
  registerSlackOps();
  registerWebhookVerifier(slackWebhookVerifier);
  registerProviderDocs("slack", PROVIDER_DOCS);
}
