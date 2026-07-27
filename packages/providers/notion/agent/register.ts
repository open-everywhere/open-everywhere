import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerProviderDocs,
  registerWebhookVerifier,
  registerEventNormalizer,
  registerEventScopeGrant,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { bindNotion } from "./channels/notion-identity.js";
import { notionPostArm } from "./channels/notion-post-arm.js";
import { notionWakeOriginCodec } from "./channels/notion-origin-codec.js";
import { notionWebhookVerifier } from "./channels/notion-webhook-verifier.js";
import { notionEventNormalizer, notionEventScopeGrant } from "./channels/notion-event-normalizer.js";
import { registerNotionMemory } from "./memory/memory.js";

export function registerNotionProvider(): void {
  registerIdentityMapper("notion", bindNotion);
  registerCapabilityManifest("notion", { midTurnPost: true, reactions: false });
  registerPostArm(notionPostArm);
  registerWakeOriginCodec("notion", notionWakeOriginCodec);
  registerWebhookVerifier(notionWebhookVerifier);
  registerEventNormalizer(notionEventNormalizer);
  registerEventScopeGrant(notionEventScopeGrant);
  registerNotionMemory();
  registerProviderDocs("notion", PROVIDER_DOCS);
}
