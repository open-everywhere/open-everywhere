import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerReactionSurface,
  registerSlackBridge,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack, partnerFactsFromInfo } from "./channels/slack-identity.js";
import { slackPostArm } from "./channels/slack-post-arm.js";
import { slackWakeOriginCodec } from "./channels/slack-origin-codec.js";
import { slackReadAdapter, callSlackRead, readableChannelList } from "./channels/slack-read.js";
import { registerSlackAttachmentResolver } from "./channels/slack-attachments.js";
import {
  slackForm,
  fetchUserDisplayName,
  fetchChannelDisplayName,
  botDisplayName,
  confirmChannelInternal,
  registerSlackGovernanceMembers,
} from "./channels/slack-events.js";
import slackChannel from "./channels/slack.js";
import { registerSlackOps } from "./ops.js";

export function registerSlackProvider(): void {
  registerIdentityMapper("slack", bindSlack);
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true });
  registerPostArm(slackPostArm);
  registerWakeOriginCodec("slack", slackWakeOriginCodec);
  registerReadAdapter(slackReadAdapter);
  registerReactionSurface("slack");
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
    readableChannelList,
    channel: slackChannel,
  });
  registerSlackOps();
}
