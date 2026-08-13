import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
  registerProviderDocs,
  registerWebhookVerifier,
} from "@open-everywhere/core/agent/adapter-api.js";
import { PROVIDER_DOCS } from "./docs-generated.js";
import { registerGithubOps } from "./ops.js";
import { registerGitHubMemory, declareGitHubMemoryCapability } from "./memory/memory.js";
import { bindGitHub } from "./channels/github-identity.js";
import { githubPostArm } from "./channels/github-post-arm.js";
import { githubWakeOriginCodec } from "./channels/github-origin-codec.js";
import { githubWebhookVerifier } from "./channels/github-webhook-verifier.js";

export function registerGithubProvider(): void {
  registerIdentityMapper("github", bindGitHub);
  registerCapabilityManifest("github", { midTurnPost: false, reactions: false });
  registerPostArm(githubPostArm);
  registerWakeOriginCodec("github", githubWakeOriginCodec);
  registerWebhookVerifier(githubWebhookVerifier);
  registerProviderDocs("github", PROVIDER_DOCS);
  registerGithubOps();

  if (!registerGitHubMemory()) declareGitHubMemoryCapability();
}
