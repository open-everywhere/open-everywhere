import {
  registerCapabilityManifest,
  registerEmailTransport,
  registerOperatorSecretNames,
  registerIdentityMapper,
  registerPostArm,
  registerProviderDocs,
  registerProviderEvents,
  registerReadAdapter,
  registerSurfaceMessageOps,
  registerSurfaceParity,
  registerWakeOriginCodec,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { EMAIL_SURFACE_PARITY } from "./surface-parity.js";
import { EMAIL_PROVIDER_EVENTS } from "./provider-events.js";
import { bindEmail } from "./channels/email-identity.js";
import { emailPostArm } from "./channels/email-post-arm.js";
import { emailWakeOriginCodec } from "./channels/email-origin-codec.js";
import { emailReadAdapter } from "./channels/email-read.js";
import { emailMessageOps } from "./channels/email-message-ops.js";
import { AGENTMAIL_API_HOSTS, AGENTMAIL_API_KEY_SECRET, AGENTMAIL_WEBHOOK_SECRET, agentMailTransport } from "./transports/agentmail.js";

export function registerEmailProvider(): void {
  registerIdentityMapper("email", bindEmail);
  registerCapabilityManifest("email", { midTurnPost: true, reactions: false, closingProseDropped: true });
  registerSurfaceParity("email", EMAIL_SURFACE_PARITY);
  registerProviderEvents("email", EMAIL_PROVIDER_EVENTS);
  registerPostArm(emailPostArm);
  registerWakeOriginCodec("email", emailWakeOriginCodec);
  registerReadAdapter(emailReadAdapter);
  registerSurfaceMessageOps(emailMessageOps);
  registerOperatorSecretNames([AGENTMAIL_API_KEY_SECRET, AGENTMAIL_WEBHOOK_SECRET]);
  registerEmailTransport(agentMailTransport("agentmail", AGENTMAIL_API_HOSTS.us));
  registerEmailTransport(agentMailTransport("agentmail-eu", AGENTMAIL_API_HOSTS.eu));
  registerProviderDocs("email", PROVIDER_DOCS);
}
