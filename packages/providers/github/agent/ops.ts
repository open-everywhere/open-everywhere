import { registerSurfaceCredentialProbe } from "@open-everywhere/core/agent/adapter-api.js";

export function registerGithubOps(): void {
  registerSurfaceCredentialProbe("github", () => Boolean(process.env.OE_GITHUB_APP_ID));
}
