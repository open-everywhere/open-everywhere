export const SLACK_DEPLOY_HOST_PLACEHOLDER = "YOUR-DEPLOY-URL";

export const SLACK_DEFAULT_APP_NAME = "Open Everywhere";

export const SLACK_APP_NAME_MAX = 35;

export function slackAppNameProblem(raw: string): string | undefined {
  const name = raw.trim();
  if (name === "") return "the app name is empty";
  if (name.length > SLACK_APP_NAME_MAX) return `the app name is ${name.length} characters; Slack accepts at most ${SLACK_APP_NAME_MAX}`;
  return undefined;
}

export interface SlackAppManifestOptions {
  readonly appName?: string;
}

export function slackAppManifestTemplate(opts: SlackAppManifestOptions = {}): string {
  const appName = opts.appName?.trim() || SLACK_DEFAULT_APP_NAME;
  return JSON.stringify(
    {
      display_information: { name: appName },
      features: {
        app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: appName, always_online: true },
        slash_commands: [
          {
            command: "/oe",
            url: `https://${SLACK_DEPLOY_HOST_PLACEHOLDER}/eve/v1/slack/commands`,
            description: "Open Everywhere control-plane commands (stop, status, budget) — no model turn.",
            usage_hint: "stop | status | budget [raise <usd> | clear] | rate <n> | help",
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
        redirect_urls: [`https://${SLACK_DEPLOY_HOST_PLACEHOLDER}/setup/callback`],
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
            "mpim:history",
            "mpim:read",
            "files:write",
            "files:read",
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
          bot_events: [
            "app_mention",
            "message.im",
            "message.channels",
            "message.groups",
            "message.mpim",
            "member_joined_channel",
            "reaction_added",
            "reaction_removed",
          ],
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
  "Before the first deploy, Slack cannot verify the Event Subscriptions URL: it answers only once a deploy that holds SLACK_SIGNING_SECRET is up. After the deploy, paste the manifest again with the real host (App Manifest → Save Changes), then retry the verification under Event Subscriptions.",
];

export const SLACK_APP_MANIFEST_COLLECT: readonly string[] = [
  "OAuth & Permissions → Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN",
  "Basic Information → App Credentials → Signing Secret = SLACK_SIGNING_SECRET",
  "The workspace (team) id, T… — the segment after /client/ in the workspace URL at https://app.slack.com — for the vouch in agent/identity/surfaces.ts",
  "Your own member id, U… — your Slack profile → ⋮ (More) → Copy member ID — for admins in agent/memory/config/domains/org.ts",
];
