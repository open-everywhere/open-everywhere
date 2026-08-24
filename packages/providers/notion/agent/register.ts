import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerProviderDocs,
  registerWebhookVerifier,
  registerEventNormalizer,
  registerEventScopeGrant,
  registerSubtreePlatform,
  registerSurfaceMessageOps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerNotionTrustRoots } from "./channels/notion-ancestry-trust.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { bindNotion } from "./channels/notion-identity.js";
import { notionPostArm } from "./channels/notion-post-arm.js";
import { notionMessageOps } from "./channels/notion-message-ops.js";
import { notionWakeOriginCodec } from "./channels/notion-origin-codec.js";
import { notionReadAdapter } from "./channels/notion-read.js";
import { registerNotionWorkSearch } from "./channels/notion-work-search.js";
import { registerNotionGrantVerbs } from "./channels/notion-grant-verbs.js";
import { notionWebhookVerifier } from "./channels/notion-webhook-verifier.js";
import { notionEventNormalizer, notionEventScopeGrant } from "./channels/notion-event-normalizer.js";
import { registerNotionMemory } from "./memory/memory.js";

export function registerNotionProvider(): void {
  registerIdentityMapper("notion", bindNotion);
  registerCapabilityManifest("notion", { midTurnPost: true, reactions: false, supervisorProseDropped: true });
  registerPostArm(notionPostArm);
  registerSurfaceMessageOps(notionMessageOps);
  registerWakeOriginCodec("notion", notionWakeOriginCodec);
  registerReadAdapter(notionReadAdapter);
  registerNotionWorkSearch();
  registerNotionGrantVerbs();
  registerWebhookVerifier(notionWebhookVerifier);
  registerEventNormalizer(notionEventNormalizer);
  registerEventScopeGrant(notionEventScopeGrant);
  registerSubtreePlatform("notion", registerNotionTrustRoots);
  registerNotionMemory();
  registerProviderDocs("notion", PROVIDER_DOCS);
}
