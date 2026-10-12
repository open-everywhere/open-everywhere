import {
  registerCapabilityManifest,
  registerIdentityMapper,
  registerPostArm,
  registerProviderDocs,
  registerProviderEvents,
  registerSurfaceCredentialProbe,
  registerSurfaceMessageOps,
  registerSurfaceParity,
  registerWakeOriginCodec,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { GOOGLE_CHAT_SURFACE_PARITY } from "./surface-parity.js";
import { GOOGLE_CHAT_PROVIDER_EVENTS } from "./provider-events.js";
import { googleChatPolicy } from "./policy.js";
import { bindGoogleChat } from "./channels/google-chat-identity.js";
import { googleChatPostArm } from "./channels/google-chat-post-arm.js";
import { googleChatWakeOriginCodec } from "./channels/google-chat-origin-codec.js";
import { googleChatMessageOps } from "./channels/google-chat-message-ops.js";

export function registerGoogleChatProvider(): void {
  registerIdentityMapper("google-chat", bindGoogleChat);
  registerCapabilityManifest("google-chat", { midTurnPost: true, reactions: false, closingProseDropped: true });
  registerSurfaceParity("google-chat", GOOGLE_CHAT_SURFACE_PARITY);
  registerProviderEvents("google-chat", GOOGLE_CHAT_PROVIDER_EVENTS);
  registerPostArm(googleChatPostArm);
  registerWakeOriginCodec("google-chat", googleChatWakeOriginCodec);
  registerSurfaceMessageOps(googleChatMessageOps);
  registerSurfaceCredentialProbe("google-chat", () => googleChatPolicy().enabled);
  registerProviderDocs("google-chat", PROVIDER_DOCS);
}
