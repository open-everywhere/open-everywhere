import {
  registerQuickstartSurfaceGoal,
  registerSurfaceAppManifest,
  registerSurfaceCredentialProbe,
  type PlanStep,
} from "@open-everywhere/core/agent/adapter-api-ops.js";
import {
  SLACK_APP_CONSOLE_URL,
  SLACK_APP_MANIFEST_COLLECT,
  SLACK_APP_MANIFEST_STEPS,
  SLACK_APP_NAME_MAX,
  slackAppManifestTemplate,
} from "./app-manifest.js";

const set = (v: string | undefined): boolean => v !== undefined && v !== "";

const SLACK_HOSTED_ENV = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;

function slackAfterDeploySteps(): readonly PlanStep[] {
  return [
    {
      id: "slack-urls",
      title: "Point the Slack app at the deployment",
      status: "todo",
      detail:
        "Slack verifies the Event Subscriptions URL by sending it a signed challenge, so the verification fails until a deploy that " +
        "holds SLACK_SIGNING_SECRET is up. Fetch the manifest with the real host, then in the Slack app: App Manifest → paste it → " +
        "Save Changes. That sets all three URLs (Event Subscriptions and Interactivity: https://<host>/eve/v1/slack; the /oe slash " +
        "command: https://<host>/eve/v1/slack/commands). Then Event Subscriptions → Retry (or re-save) until Slack shows Verified. " +
        "Verified is the only check that proves the deployment holds SLACK_SIGNING_SECRET: the wizard's --host probe gets the same 401 without it.",
      command: 'surface_manifest { surface: "slack", baseUrl: "https://<host>" }',
    },
  ];
}

export function registerSlackOps(): void {
  registerQuickstartSurfaceGoal(
    "slack",
    (env) => {
      const ok = set(env.SLACK_BOT_TOKEN) && set(env.SLACK_SIGNING_SECRET);
      const missing = [
        ...(set(env.SLACK_BOT_TOKEN) ? [] : ["SLACK_BOT_TOKEN"]),
        ...(set(env.SLACK_SIGNING_SECRET) ? [] : ["SLACK_SIGNING_SECRET"]),
      ];
      return {
        id: "slack",
        title: "Slack app",
        status: ok ? "done" : "todo",
        detail:
          "Create a Slack app from the manifest the ops tool `surface_manifest { surface: \"slack\" }` returns (before the first deploy " +
          "it keeps the YOUR-DEPLOY-URL placeholder), install it, then copy the bot token and the signing secret. Slack reserves app " +
          "creation for a workspace admin, so this step needs a person. The bundle reads both values from the environment, not the " +
          `credential store.${ok ? "" : ` Missing: ${missing.join(", ")}.`}`,
        command: ok ? undefined : `scaffold_env { values: { ${missing.map((n) => `${n}: "<value>"`).join(", ")} } } — the person pastes each value; never echo one`,
      };
    },
    { env: SLACK_HOSTED_ENV, afterDeploy: slackAfterDeploySteps },
  );
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
