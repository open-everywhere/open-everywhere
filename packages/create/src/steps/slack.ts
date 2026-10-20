import { slackAppManifestTemplate, slackManifestAppName, type SlackAppManifestOptions } from "@open-everywhere/provider-slack/agent/app-manifest.js";
import { docUrl } from "@open-everywhere/core/agent/ops/quickstart.js";
import { routeOf, type SetupStep, type StepContext } from "../engine.js";
import { isSet, mergedEnv, missNote } from "../env-file.js";

const SLACK_ENV = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;

const PROJECT_MARK_URL = "https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/brand/png/mark-square-1024.png";

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
          "SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET set in the environment — the operator-secret on-ramp. For the deployment, store both with " +
          "`npx oe secret set`. 🔴 Either home makes the deployment IGNORE anything /setup stored, and CLOSES /setup: the operator " +
          "secret comes first, so landing that page cannot change which Slack app a working deployment speaks as",
      };
    }
    return {
      satisfied: false,
      detail:
        `missing from .env.local and this shell: ${missing.join(", ")}. This check reads those two homes only — a deployment ` +
        "that stored both with `npx oe secret set`, or configured by /setup, keeps them in its own encrypted credential store, and " +
        `reports unsatisfied here while working correctly. The status endpoint, \`npx oe secret list\` and /setup itself are what can see the store. ${missNote(routeOf(ctx))}`,
      next:
        'open https://<host>/setup once the deployment is up (it creates and installs the Slack app from one pasted configuration ' +
        'token, with no env var to set), or create the app from the manifest the ops tool `surface_manifest { surface: "slack" }` ' +
        "returns, then have the person run `npx oe secret set SLACK_BOT_TOKEN` and `npx oe secret set SLACK_SIGNING_SECRET` in their own terminal (value on stdin)",
    };
  },
  guide(ctx: StepContext) {
    const opts: SlackAppManifestOptions = {
      ...(ctx.appName === undefined ? {} : { appName: ctx.appName }),
      ...(ctx.agentName === undefined ? {} : { agentName: ctx.agentName }),
      ...(ctx.commandName === undefined ? {} : { commandName: ctx.commandName }),
    };
    return {
      summary: "Create a Slack app from the manifest below, then copy its bot token and signing secret.",
      instructions: [
        "https://api.slack.com/apps → Create New App → From an app manifest → pick the workspace → JSON → paste:",
        slackAppManifestTemplate(opts),
        `The app is named "${slackManifestAppName(opts)}" (${
          ctx.appName !== undefined
            ? "from --app-name"
            : ctx.agentName !== undefined
              ? "from the app's identity.name setting"
              : "the default — set identity.name in agent/settings/settings.ts to name it"
        }). A second install in one workspace needs its own name: re-run with --app-name "<name>".`,
        "Install to Workspace, then OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN.",
        `Basic Information → Display Information → App icon: ${
          ctx.appName === undefined && ctx.agentName === undefined
            ? "upload the project mark"
            : "upload your own icon, or the project mark"
        }, ${PROJECT_MARK_URL}. Slack's manifest has no icon field, so this step stays by hand.`,
        "Basic Information → App Credentials → copy the Signing Secret = SLACK_SIGNING_SECRET.",
        "Store both as operator secrets with `npx oe secret set SLACK_BOT_TOKEN` and `npx oe secret set SLACK_SIGNING_SECRET`, run in your own terminal: each reads the value from stdin and writes the deployment's encrypted credential store. For a local run only, `npx oe env set <NAME>` puts the value in .env.local instead. Never paste a secret into the chat, and never pass one to an ops tool.",
        "THE SHORT WAY, once the deployment is up: open https://<host>/setup. It creates the Slack app from this same manifest with one pasted Slack app configuration token, installs it, and keeps every credential in the deployment's own encrypted store — no env var to set. This check cannot see that store, so it still reports this step unsatisfied afterwards; the status endpoint can.",
        "The manifest's URLs say YOUR-DEPLOY-URL until you deploy. Slack cannot verify Event Subscriptions before a deploy that holds SLACK_SIGNING_SECRET is up. After the deploy, paste the manifest again with your host (App Manifest → Save Changes), then retry the verification under Event Subscriptions.",
        "Note two ids for the trust edits: the workspace (team) id T… (the segment after /client/ in the workspace URL at https://app.slack.com), and your own member id U… (your Slack profile → ⋮ More → Copy member ID).",
        `Full walkthrough: ${docUrl("docs/deploy/surfaces/slack.md")}.`,
      ],
    };
  },
};
