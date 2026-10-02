export type { Check } from "./ops/quickstart.js";
export { registerSurfaceAppManifest, DEPLOY_HOST_PLACEHOLDER } from "./ops/surface-manifest.js";
export { registerPreflightProbe } from "./ops/probes.js";
export { registerSurfaceCredentialProbe } from "./observability/telemetry.js";
export { registerSurfaceStatusReporter } from "./ops/status.js";
export type { SurfaceStatus, StatusVerdict } from "./ops/status.js";
