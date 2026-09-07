import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerSurfaceParity,
  registerPostArm,
  registerWakeOriginCodec,
  registerReadAdapter,
  registerEntityActionAdapter,
  registerTicketCreateAdapter,
  registerSurfaceCredentialProbe,
  registerProviderDocs,
  registerEventNormalizer,
  registerEventScopeGrant,
  registerSurfaceMessageOps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { LINEAR_SURFACE_PARITY } from "./surface-parity.js";
import { bindLinear } from "./channels/linear-identity.js";
import { linearPostArm } from "./channels/linear-post-arm.js";
import { linearWakeOriginCodec } from "./channels/linear-origin-codec.js";
import { linearEntityAdapter } from "./channels/linear-actions.js";
import { linearTicketCreateAdapter } from "./channels/linear-create.js";
import { linearCredentialsConfigured } from "./channels/linear-credentials.js";
import { linearEventNormalizer, linearEventScopeGrant } from "./channels/linear-event-normalizer.js";
import { linearMessageOps } from "./channels/linear-message-ops.js";
import { linearReadAdapter } from "./channels/linear-read.js";
import { registerLinearWorkSearch } from "./channels/linear-work-search.js";

export function registerLinearProvider(): void {
  registerIdentityMapper("linear", bindLinear);
  registerCapabilityManifest("linear", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  registerSurfaceParity("linear", LINEAR_SURFACE_PARITY);
  registerPostArm(linearPostArm);
  registerSurfaceMessageOps(linearMessageOps);
  registerWakeOriginCodec("linear", linearWakeOriginCodec);
  registerReadAdapter(linearReadAdapter);
  registerLinearWorkSearch();
  registerEntityActionAdapter(linearEntityAdapter);
  registerTicketCreateAdapter(linearTicketCreateAdapter);
  registerSurfaceCredentialProbe("linear", linearCredentialsConfigured);
  registerEventNormalizer(linearEventNormalizer);
  registerEventScopeGrant(linearEventScopeGrant);
  registerProviderDocs("linear", PROVIDER_DOCS);
}
