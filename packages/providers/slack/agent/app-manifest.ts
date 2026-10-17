import { SLACK_MCP_BOT_SCOPE, slackAsYouUserScopes } from "./slack-as-you.js";

export const SLACK_DEPLOY_HOST_PLACEHOLDER = "YOUR-DEPLOY-URL";

export const SLACK_DEFAULT_APP_NAME = "Open Everywhere";

const SLACK_DEFAULT_COMMAND_NAME = "oe";

export const SLACK_SHORTCUT_NAME_MAX = 24;

export const SLACK_APP_NAME_MAX = 35;

export function slackAppNameProblem(raw: string): string | undefined {
  const name = raw.trim();
  if (name === "") return "the app name is empty";
  if (name.length > SLACK_APP_NAME_MAX) return `the app name is ${name.length} characters; Slack accepts at most ${SLACK_APP_NAME_MAX}`;
  return undefined;
}

export interface SlackAppManifestOptions {
  readonly appName?: string;
  readonly agentName?: string;
  readonly commandName?: string;
  readonly personalMcp?: boolean;
  readonly suggestedPrompts?: readonly { readonly title: string; readonly message: string }[];
}

export const SLACK_AGENT_DESCRIPTION_MAX = 300;

function slackAgentDescription(appName: string): string {
  return `Ask ${appName} beside anything you are reading in Slack. It is your own direct-message conversation, with the same rules as a DM.`.slice(
    0,
    SLACK_AGENT_DESCRIPTION_MAX,
  );
}

export const SLACK_PERSONAL_SIGN_IN_CALLBACK_PATH = "/oauth/v1/callback";

export function slackManifestAppName(opts: SlackAppManifestOptions = {}): string {
  const explicit = opts.appName?.trim();
  if (explicit) return explicit;
  const configured = opts.agentName?.trim();
  if (configured) return configured.slice(0, SLACK_APP_NAME_MAX).trim();
  return SLACK_DEFAULT_APP_NAME;
}

function shortcutName(prefix: string, appName: string, neutral: string): string {
  const named = `${prefix} ${appName}`;
  return named.length <= SLACK_SHORTCUT_NAME_MAX ? named : neutral;
}

export function slackAppManifestTemplate(opts: SlackAppManifestOptions = {}): string {
  const appName = slackManifestAppName(opts);
  const commandName = opts.commandName?.trim() || SLACK_DEFAULT_COMMAND_NAME;
  const personalMcp = opts.personalMcp === true;
  return JSON.stringify(
    {
      display_information: { name: appName },
      features: {
        app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        agent_view: {
          agent_description: slackAgentDescription(appName),
          ...(opts.suggestedPrompts && opts.suggestedPrompts.length > 0
            ? { suggested_prompts: opts.suggestedPrompts.map((p) => ({ title: p.title, message: p.message })) }
            : {}),
        },
        bot_user: { display_name: appName, always_online: true },
        slash_commands: [
          {
            command: `/${commandName}`,
            url: `https://${SLACK_DEPLOY_HOST_PLACEHOLDER}/eve/v1/slack/commands`,
            description: `${appName} control-plane commands (stop, status, budget) — no model turn.`,
            usage_hint: "stop | status | budget [raise <usd> | clear] | rate <n> | optout [on | off] | watch [more | less | none] | cover [on | off] | help",
            should_escape: false,
          },
        ],
        shortcuts: [
          {
            name: shortcutName("Send to", appName, "Send to the agent"),
            type: "message",
            callback_id: "oe_message_shortcut",
            description: "Wake the agent on this message.",
          },
          {
            name: shortcutName("Ask", appName, "Ask the agent"),
            type: "global",
            callback_id: "oe_global_shortcut",
            description: "Wake the agent in a DM.",
          },
        ],
      },
      oauth_config: {
        redirect_urls: [
          `https://${SLACK_DEPLOY_HOST_PLACEHOLDER}/setup/callback`,
          ...(personalMcp ? [`https://${SLACK_DEPLOY_HOST_PLACEHOLDER}${SLACK_PERSONAL_SIGN_IN_CALLBACK_PATH}`] : []),
        ],
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
            "canvases:write",
            "assistant:write",
            ...(personalMcp ? [SLACK_MCP_BOT_SCOPE] : []),
          ],
          ...(personalMcp ? { user: [...slackAsYouUserScopes()] } : {}),
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
            "app_home_opened",
            "channel_shared",
            "user_change",
            "app_context_changed",
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
  "Unless you set identity.name and chose your own icon, give the app the project mark: Basic Information → Display Information → App icon, and upload https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/brand/png/mark-square-1024.png. Slack's manifest has no icon field, so this step stays by hand.",
  "Before the first deploy, Slack cannot verify the Event Subscriptions URL: it answers only once a deploy that holds SLACK_SIGNING_SECRET is up. After the deploy, paste the manifest again with the real host (App Manifest → Save Changes), then retry the verification under Event Subscriptions.",
];

export const SLACK_APP_MANIFEST_COLLECT: readonly string[] = [
  "OAuth & Permissions → Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN",
  "Basic Information → App Credentials → Signing Secret = SLACK_SIGNING_SECRET",
  "The workspace (team) id, T… — the segment after /client/ in the workspace URL at https://app.slack.com — for the vouch in agent/identity/surfaces.ts",
  "Your own member id, U… — your Slack profile → ⋮ (More) → Copy member ID — for admins in agent/memory/config/domains/org.ts",
];
