import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerProviderDocs,
  registerReadAdapter,
  registerWebhookVerifier,
  registerSurfaceMessageOps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { registerGithubOps } from "./ops.js";
import { registerGitHubMemory, declareGitHubMemoryCapability } from "./memory/memory.js";
import { bindGitHub } from "./channels/github-identity.js";
import { githubPostArm } from "./channels/github-post-arm.js";
import { githubWakeOriginCodec } from "./channels/github-origin-codec.js";
import { githubWebhookVerifier } from "./channels/github-webhook-verifier.js";
import { githubReadAdapter } from "./channels/github-read.js";
import { githubMessageOps } from "./channels/github-message-ops.js";

export function registerGithubProvider(): void {
  registerIdentityMapper("github", bindGitHub);
  registerCapabilityManifest("github", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  registerPostArm(githubPostArm);
  registerWakeOriginCodec("github", githubWakeOriginCodec);
  registerReadAdapter(githubReadAdapter);
  registerSurfaceMessageOps(githubMessageOps);
  registerWebhookVerifier(githubWebhookVerifier);
  registerProviderDocs("github", PROVIDER_DOCS);
  registerGithubOps();

  if (!registerGitHubMemory()) declareGitHubMemoryCapability();
}
