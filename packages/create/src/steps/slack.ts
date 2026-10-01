import { SLACK_DEFAULT_APP_NAME, slackAppManifestTemplate } from "@open-everywhere/provider-slack/agent/app-manifest.js";
import { docUrl } from "@open-everywhere/core/agent/ops/quickstart.js";
import { goalOf, type StepContext, type WizardIO, type WizardStep } from "../engine.js";
import { HOSTED_MISS_NOTE, isSet, mergedEnv, writeEnvLocal } from "../env-file.js";

const SLACK_ENV = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;

export const slackStep: WizardStep = {
  id: "slack",
  title: "Slack app",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env);
    const missing = SLACK_ENV.filter((name) => !isSet(env[name]));
    if (missing.length === 0) return { satisfied: true, detail: "SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET set" };
    if (goalOf(ctx) === "local") return { satisfied: true, detail: `optional for a local run (missing: ${missing.join(", ")})` };
    return {
      satisfied: false,
      detail: `missing from .env.local and this shell: ${missing.join(", ")}. ${HOSTED_MISS_NOTE}`,
      next: "create the Slack app from the manifest (`npx create-open-everywhere` prints it, or the ops tool `surface_manifest`), then the person pastes each value in a terminal (`npx create-open-everywhere`) or into .env.local",
    };
  },
  guide(ctx: StepContext) {
    return {
      summary: "Create a Slack app from the manifest below, then copy its bot token + signing secret.",
      instructions: [
        "https://api.slack.com/apps → Create New App → From an app manifest → pick the workspace → JSON → paste:",
        slackAppManifestTemplate(ctx.appName === undefined ? {} : { appName: ctx.appName }),
        `The app is named "${ctx.appName ?? SLACK_DEFAULT_APP_NAME}". A second install in one workspace needs its own name: re-run with --app-name "<name>".`,
        "Install to Workspace, then OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN.",
        "Basic Information → App Credentials → copy the Signing Secret = SLACK_SIGNING_SECRET.",
        "The manifest's URLs say YOUR-DEPLOY-URL until you deploy. Slack cannot verify Event Subscriptions before a deploy that holds SLACK_SIGNING_SECRET is up. After the deploy, paste the manifest again with your host (App Manifest → Save Changes), then retry the verification under Event Subscriptions.",
        "Note two ids for the trust edits: the workspace (team) id T… (the segment after /client/ in the workspace URL at https://app.slack.com), and your own member id U… (your Slack profile → ⋮ More → Copy member ID).",
        `Full walkthrough: ${docUrl("docs/deploy/surfaces/slack.md")}.`,
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
