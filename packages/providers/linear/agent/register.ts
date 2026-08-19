import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerEntityActionAdapter,
  registerTicketCreateAdapter,
  registerSurfaceCredentialProbe,
  registerProviderDocs,
  registerEventNormalizer,
  registerEventScopeGrant,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { bindLinear } from "./channels/linear-identity.js";
import { linearPostArm } from "./channels/linear-post-arm.js";
import { linearWakeOriginCodec } from "./channels/linear-origin-codec.js";
import { linearEntityAdapter } from "./channels/linear-actions.js";
import { linearTicketCreateAdapter } from "./channels/linear-create.js";
import { linearCredentialsConfigured } from "./channels/linear-credentials.js";
import { linearEventNormalizer, linearEventScopeGrant } from "./channels/linear-event-normalizer.js";

export function registerLinearProvider(): void {
  registerIdentityMapper("linear", bindLinear);
  registerCapabilityManifest("linear", { midTurnPost: true, reactions: false, supervisorProseDropped: true });
  registerPostArm(linearPostArm);
  registerWakeOriginCodec("linear", linearWakeOriginCodec);
  registerEntityActionAdapter(linearEntityAdapter);
  registerTicketCreateAdapter(linearTicketCreateAdapter);
  registerSurfaceCredentialProbe("linear", linearCredentialsConfigured);
  registerEventNormalizer(linearEventNormalizer);
  registerEventScopeGrant(linearEventScopeGrant);
  registerProviderDocs("linear", PROVIDER_DOCS);
}
