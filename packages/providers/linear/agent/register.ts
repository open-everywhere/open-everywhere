import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerEntityActionAdapter,
  registerSurfaceCredentialProbe,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindLinear } from "./channels/linear-identity.js";
import { linearPostArm } from "./channels/linear-post-arm.js";
import { linearWakeOriginCodec } from "./channels/linear-origin-codec.js";
import { linearEntityAdapter } from "./channels/linear-actions.js";
import { linearCredentialsConfigured } from "./channels/linear-credentials.js";

export function registerLinearProvider(): void {
  registerIdentityMapper("linear", bindLinear);
  registerCapabilityManifest("linear", { midTurnPost: true, reactions: false });
  registerPostArm(linearPostArm);
  registerWakeOriginCodec("linear", linearWakeOriginCodec);
  registerEntityActionAdapter(linearEntityAdapter);
  registerSurfaceCredentialProbe("linear", linearCredentialsConfigured);
}
