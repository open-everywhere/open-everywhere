import { getSettings, registerOperatorSecretNames, registerSurfaceAppCreateFlow, registerSurfaceCredentialProbe } from "@open-everywhere/core/agent/adapter-api-ops.js";
import { GITHUB_APP_CREATE_FLOW } from "./app-manifest.js";

export function registerGithubOps(): void {
  registerSurfaceCredentialProbe("github", () => getSettings().github.appId !== "");
  registerSurfaceAppCreateFlow("github", GITHUB_APP_CREATE_FLOW);
  registerOperatorSecretNames(["GITHUB_WEBHOOK_SECRET"]);
}
