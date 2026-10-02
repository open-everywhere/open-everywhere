import { registerSurfaceAppManifest, registerSurfaceCredentialProbe } from "@open-everywhere/core/agent/adapter-api-ops.js";
import {
  SLACK_APP_CONSOLE_URL,
  SLACK_APP_MANIFEST_COLLECT,
  SLACK_APP_MANIFEST_STEPS,
  SLACK_APP_NAME_MAX,
  slackAppManifestTemplate,
} from "./app-manifest.js";

export function registerSlackOps(): void {
  registerSurfaceAppManifest("slack", {
    format: "json",
    consoleUrl: SLACK_APP_CONSOLE_URL,
    steps: SLACK_APP_MANIFEST_STEPS,
    collect: SLACK_APP_MANIFEST_COLLECT,
    template: (opts) => slackAppManifestTemplate(opts),
    appNameMax: SLACK_APP_NAME_MAX,
  });
  registerSurfaceCredentialProbe("slack", () => Boolean(process.env.SLACK_BOT_TOKEN));
}
