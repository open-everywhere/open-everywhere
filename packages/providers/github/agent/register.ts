import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindGitHub } from "./channels/github-identity.js";
import { githubPostArm } from "./channels/github-post-arm.js";
import { githubWakeOriginCodec } from "./channels/github-origin-codec.js";

export function registerGithubProvider(): void {
  registerIdentityMapper("github", bindGitHub);
  registerCapabilityManifest("github", { midTurnPost: false, reactions: false });
  registerPostArm(githubPostArm);
  registerWakeOriginCodec("github", githubWakeOriginCodec);
}
