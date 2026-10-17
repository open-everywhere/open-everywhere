import { registerSurfaceAppCreateFlow, registerSurfaceCredentialProbe } from "@open-everywhere/core/agent/adapter-api-ops.js";
import { GITHUB_APP_CREATE_FLOW } from "./app-manifest.js";

export function registerGithubOps(): void {
  registerSurfaceCredentialProbe("github", () => Boolean(process.env.OE_GITHUB_APP_ID));
  registerSurfaceAppCreateFlow("github", GITHUB_APP_CREATE_FLOW);
}
