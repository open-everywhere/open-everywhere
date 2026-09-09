import { slackAppManifestTemplate } from "@open-everywhere/provider-slack/agent/app-manifest.js";
import type { StepContext, WizardIO, WizardStep } from "../engine.js";
import { isSet, mergedEnv, writeEnvLocal } from "../env-file.js";

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
        slackAppManifestTemplate(),
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
