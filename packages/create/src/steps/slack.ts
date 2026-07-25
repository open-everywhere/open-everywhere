import type { StepContext, WizardIO, WizardStep } from "../engine.js";
import { isSet, mergedEnv, writeEnvLocal } from "../env-file.js";

export function slackManifest(): string {
  return JSON.stringify(
    {
      display_information: { name: "Open Everywhere" },
      features: {
        bot_user: { display_name: "Open Everywhere", always_online: true },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "chat:write",
            "channels:history",
            "im:history",
            "im:write",
            "groups:history",
            "reactions:write",
            "reactions:read",
            "pins:read",
            "pins:write",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: "https://YOUR-DEPLOY-URL/eve/v1/slack",
          bot_events: ["app_mention", "message.im", "reaction_added", "reaction_removed"],
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}

export const slackStep: WizardStep = {
  id: "slack",
  title: "Slack app",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env);
    const satisfied = isSet(env.SLACK_BOT_TOKEN) && isSet(env.SLACK_SIGNING_SECRET);
    return { satisfied, detail: satisfied ? "SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET set" : "Slack credentials missing" };
  },
  guide() {
    return {
      summary: "Create a Slack app from the manifest below, then copy its bot token + signing secret.",
      instructions: [
        "https://api.slack.com/apps → Create New App → From an app manifest → paste:",
        slackManifest(),
        "Install to your workspace, then OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN.",
        "Basic Information → App Credentials → copy the Signing Secret = SLACK_SIGNING_SECRET.",
        "Replace YOUR-DEPLOY-URL in the manifest's request_url with your real deploy URL (or a tunnel URL locally) before Slack can verify it.",
        "Full walkthrough: docs/deploy/surfaces/slack.md.",
      ],
    };
  },
  async automate(ctx: StepContext, io: WizardIO) {
    const wantsSlack = await io.confirm("Set up Slack now?");
    if (!wantsSlack) return { ran: false, ok: false, detail: "skipped" };
    const token = await io.askSecret("Bot User OAuth Token (xoxb-...)");
    const secret = await io.askSecret("Signing Secret");
    if (!token || !secret) return { ran: true, ok: false, detail: "one or both values were empty" };
    writeEnvLocal(ctx.cwd, { SLACK_BOT_TOKEN: token, SLACK_SIGNING_SECRET: secret });
    return { ran: true, ok: true, detail: "saved to .env.local (values not shown here or ever logged)" };
  },
};
