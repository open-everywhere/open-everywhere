import {
  registerQuickstartSurfaceGoal,
  registerSurfaceAppManifest,
  registerSurfaceCredentialProbe,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  SLACK_APP_CONSOLE_URL,
  SLACK_APP_MANIFEST_COLLECT,
  SLACK_APP_MANIFEST_STEPS,
  slackAppManifestTemplate,
} from "./app-manifest.js";

const set = (v: string | undefined): boolean => v !== undefined && v !== "";

export function registerSlackOps(): void {
  registerQuickstartSurfaceGoal("slack", (env) => {
    const ok = set(env.SLACK_BOT_TOKEN) && set(env.SLACK_SIGNING_SECRET);
    return {
      id: "slack",
      title: "Slack app",
      status: ok ? "done" : "todo",
      detail:
        "Create a Slack app from the manifest the ops tool `surface_manifest { surface: \"slack\" }` returns, then copy the bot " +
        "token + signing secret. Slack reserves app creation for a workspace admin, so this step needs a person.",
      command: ok ? undefined : "set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET in .env.local",
    };
  });
  registerSurfaceAppManifest("slack", {
    format: "json",
    consoleUrl: SLACK_APP_CONSOLE_URL,
    steps: SLACK_APP_MANIFEST_STEPS,
    collect: SLACK_APP_MANIFEST_COLLECT,
    template: slackAppManifestTemplate,
  });
  registerSurfaceCredentialProbe("slack", () => Boolean(process.env.SLACK_BOT_TOKEN));
}
