import { SLACK_DEFAULT_APP_NAME, slackAppManifestTemplate } from "@open-everywhere/provider-slack/agent/app-manifest.js";
import { docUrl } from "@open-everywhere/core/agent/ops/quickstart.js";
import { routeOf, type SetupStep, type StepContext } from "../engine.js";
import { isSet, mergedEnv, missNote } from "../env-file.js";

const SLACK_ENV = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;

export const slackStep: SetupStep = {
  id: "slack",
  title: "Slack app",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env);
    const missing = SLACK_ENV.filter((name) => !isSet(env[name]));
    if (missing.length === 0) {
      return {
        satisfied: true,
        detail:
          "SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET set in the environment. 🔴 Setting these two makes the deployment IGNORE anything " +
          "/setup stored, and CLOSES /setup: the resolver is env-first, so landing that page cannot change which Slack app a working " +
          "deployment speaks as",
      };
    }
    return {
      satisfied: false,
      detail:
        `missing from .env.local and this shell: ${missing.join(", ")}. This check reads those two homes only — a deployment ` +
        "configured by /setup keeps both secrets in its own encrypted credential store, and reports unsatisfied here while working " +
        `correctly. The status endpoint and /setup itself are what can see the store. ${missNote(routeOf(ctx))}`,
      next:
        'open https://<host>/setup once the deployment is up (it creates and installs the Slack app from one pasted configuration ' +
        'token, with no env var to set), or create the app from the manifest the ops tool `surface_manifest { surface: "slack" }` ' +
        "returns and write each pasted value with `scaffold_env`",
    };
  },
  guide(ctx: StepContext) {
    return {
      summary: "Create a Slack app from the manifest below, then copy its bot token and signing secret.",
      instructions: [
        "https://api.slack.com/apps → Create New App → From an app manifest → pick the workspace → JSON → paste:",
        slackAppManifestTemplate(ctx.appName === undefined ? {} : { appName: ctx.appName }),
        `The app is named "${ctx.appName ?? SLACK_DEFAULT_APP_NAME}". A second install in one workspace needs its own name: re-run with --app-name "<name>".`,
        "Install to Workspace, then OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN.",
        "Basic Information → App Credentials → copy the Signing Secret = SLACK_SIGNING_SECRET.",
        "Write both with the ops tool `scaffold_env`. Never paste a secret into the chat: the person pastes it where the tool reads it.",
        "THE SHORT WAY, once the deployment is up: open https://<host>/setup. It creates the Slack app from this same manifest with one pasted Slack app configuration token, installs it, and keeps every credential in the deployment's own encrypted store — no env var to set. This check cannot see that store, so it still reports this step unsatisfied afterwards; the status endpoint can.",
        "The manifest's URLs say YOUR-DEPLOY-URL until you deploy. Slack cannot verify Event Subscriptions before a deploy that holds SLACK_SIGNING_SECRET is up. After the deploy, paste the manifest again with your host (App Manifest → Save Changes), then retry the verification under Event Subscriptions.",
        "Note two ids for the trust edits: the workspace (team) id T… (the segment after /client/ in the workspace URL at https://app.slack.com), and your own member id U… (your Slack profile → ⋮ More → Copy member ID).",
        `Full walkthrough: ${docUrl("docs/deploy/surfaces/slack.md")}.`,
      ],
    };
  },
};
