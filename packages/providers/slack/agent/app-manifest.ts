export const SLACK_DEPLOY_HOST_PLACEHOLDER = "YOUR-DEPLOY-URL";

export function slackAppManifestTemplate(): string {
  return JSON.stringify(
    {
      display_information: { name: "Open Everywhere" },
      features: {
        bot_user: { display_name: "Open Everywhere", always_online: true },
        slash_commands: [
          {
            command: "/oe",
            url: `https://${SLACK_DEPLOY_HOST_PLACEHOLDER}/eve/v1/slack/commands`,
            description: "Open Everywhere control commands — status, budget, stop.",
            usage_hint: "stop | status | budget",
            should_escape: false,
          },
        ],
        shortcuts: [
          {
            name: "Send to Open Everywhere",
            type: "message",
            callback_id: "oe_message_shortcut",
            description: "Wake the agent on this message.",
          },
          {
            name: "Ask Open Everywhere",
            type: "global",
            callback_id: "oe_global_shortcut",
            description: "Wake the agent in a DM.",
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "chat:write",
            "channels:history",
            "commands",
            "channels:read",
            "groups:read",
            "im:history",
            "im:read",
            "im:write",
            "groups:history",
            "mpim:read",
            "reactions:write",
            "reactions:read",
            "pins:read",
            "pins:write",
            "users:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: `https://${SLACK_DEPLOY_HOST_PLACEHOLDER}/eve/v1/slack`,
          bot_events: ["app_mention", "message.im", "reaction_added", "reaction_removed"],
        },
        interactivity: {
          is_enabled: true,
          request_url: `https://${SLACK_DEPLOY_HOST_PLACEHOLDER}/eve/v1/slack`,
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

export const SLACK_APP_CONSOLE_URL = "https://api.slack.com/apps";

export const SLACK_APP_MANIFEST_STEPS: readonly string[] = [
  "Open https://api.slack.com/apps and sign in to the workspace that will host the agent.",
  "Create New App → From an app manifest.",
  "Pick the workspace, choose JSON, and paste the manifest below.",
  "Next → Create.",
  "Install to Workspace, and approve the scopes Slack lists.",
];

export const SLACK_APP_MANIFEST_COLLECT: readonly string[] = [
  "OAuth & Permissions → Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN",
  "Basic Information → App Credentials → Signing Secret = SLACK_SIGNING_SECRET",
];
