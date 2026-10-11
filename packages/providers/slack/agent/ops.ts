import {
  agentCommandName,
  configuredAgentName,
  declaredMcpServers,
  getSettings,
  registerSurfaceAppManifest,
  registerSurfaceCredentialProbe,
} from "@open-everywhere/core/agent/adapter-api-ops.js";
import { SLACK_AS_YOU_NAME } from "./slack-as-you.js";
import {
  SLACK_APP_CONSOLE_URL,
  SLACK_APP_MANIFEST_COLLECT,
  SLACK_APP_MANIFEST_STEPS,
  SLACK_APP_NAME_MAX,
  slackAppManifestTemplate,
  type SlackAppManifestOptions,
} from "./app-manifest.js";

export function slackManifestOptionsFromSettings(opts: { readonly appName?: string } = {}): SlackAppManifestOptions {
  const agentName = configuredAgentName();
  return {
    ...(opts.appName === undefined ? {} : { appName: opts.appName }),
    ...(agentName === undefined ? {} : { agentName }),
    commandName: agentCommandName(),
    ...(declaredMcpServers().some((s) => s.name === SLACK_AS_YOU_NAME) ? { personalMcp: true } : {}),
    suggestedPrompts: getSettings().slack.suggestedPrompts,
  };
}

export function registerSlackOps(): void {
  registerSurfaceAppManifest("slack", {
    format: "json",
    consoleUrl: SLACK_APP_CONSOLE_URL,
    steps: SLACK_APP_MANIFEST_STEPS,
    collect: SLACK_APP_MANIFEST_COLLECT,
    template: (opts) => slackAppManifestTemplate(slackManifestOptionsFromSettings(opts)),
    appNameMax: SLACK_APP_NAME_MAX,
  });
  registerSurfaceCredentialProbe("slack", () => Boolean(process.env.SLACK_BOT_TOKEN));
}
