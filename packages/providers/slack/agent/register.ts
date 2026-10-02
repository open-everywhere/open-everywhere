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
  registerBotDisplayName,
  registerAccountDisplayName,
  registerAccountDirectory,
  registerSlackBridge,
  registerProviderDocs,
  registerWebhookVerifier,
  registerBootNotice,
  registerSurfaceStatusReporter,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { slackSurfaceStatus } from "./status.js";
import { SLACK_SURFACE_PARITY } from "./surface-parity.js";
import { SLACK_PROVIDER_EVENTS } from "./provider-events.js";
import { bindSlack, partnerFactsFromInfo } from "./channels/slack-identity.js";
import { slackPostArm } from "./channels/slack-post-arm.js";
import { slackWakeOriginCodec } from "./channels/slack-origin-codec.js";
import { slackReadAdapter, callSlackRead } from "./channels/slack-read.js";
import { slackSeatCatchUpFetch, SLACK_TIMESTAMP_PRECISION_MS } from "./channels/slack-wake-backscroll.js";
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
import { announceSlackSetupCode } from "./setup/claim.js";
import { reopenSlackSetup, slackInstallState } from "./setup/install-state.js";

export function registerSlackProvider(): void {
  registerIdentityMapper("slack", bindSlack);
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, closingProseDropped: true });
  registerSurfaceParity("slack", SLACK_SURFACE_PARITY);
  registerProviderEvents("slack", SLACK_PROVIDER_EVENTS);
  registerPostArm(slackPostArm);
  registerWakeOriginCodec("slack", slackWakeOriginCodec);
  registerReadAdapter(slackReadAdapter);
  registerSeatCatchUp("slack", slackSeatCatchUpFetch, { timestampPrecisionMs: SLACK_TIMESTAMP_PRECISION_MS });
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
    installState: slackInstallState,
    reopenSetup: reopenSlackSetup,
  });
  registerSlackOps();
  registerSurfaceStatusReporter("slack", () => slackSurfaceStatus());
  registerWebhookVerifier(slackWebhookVerifier);
  registerProviderDocs("slack", PROVIDER_DOCS);
  registerBootNotice("slack-setup-code", announceSlackSetupCode);
}
