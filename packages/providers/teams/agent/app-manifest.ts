export const TEAMS_DEPLOY_HOST_PLACEHOLDER = "YOUR-DEPLOY-URL";

export const TEAMS_DEFAULT_APP_NAME = "Open Everywhere";

export const TEAMS_BRAND_ACCENT_COLOR = "#1a1a1a";

export const TEAMS_APP_NAME_MAX = 30;

const TEAMS_APP_FULL_NAME_MAX = 100;

const TEAMS_APP_MANIFEST_VERSION = "1.0.4";

const TEAMS_DEFAULT_COMMAND_NAME = "oe";

const TEAMS_COMMAND_TITLE_MAX = 32;

const TEAMS_OE_COMMAND_VERBS: readonly { readonly verb: string; readonly description: string }[] = [
  { verb: "help", description: "List the control-plane commands. No model turn." },
  { verb: "status", description: "Deployment status: build, models, memory provider. No model turn." },
  { verb: "budget", description: "Spend caps and this month's spend for this conversation. No model turn." },
  { verb: "stop", description: "Stop the turn running in this conversation. No model turn." },
];

function teamsCommandLists(commandName: string): readonly unknown[] {
  const name = commandName.trim() || TEAMS_DEFAULT_COMMAND_NAME;
  const commands = TEAMS_OE_COMMAND_VERBS.map((c) => ({ title: `${name} ${c.verb}`, description: c.description })).filter(
    (c) => c.title.length <= TEAMS_COMMAND_TITLE_MAX,
  );
  return commands.length === 0 ? [] : [{ scopes: ["team", "groupChat", "personal"], commands }];
}

export interface TeamsAppManifestOptions {
  readonly appName?: string;
  readonly agentName?: string;
  readonly commandName?: string;
}

function teamsManifestAppName(opts: TeamsAppManifestOptions = {}): string {
  const explicit = opts.appName?.trim();
  if (explicit) return explicit;
  const configured = opts.agentName?.trim();
  if (configured) return configured.slice(0, TEAMS_APP_NAME_MAX).trim();
  return TEAMS_DEFAULT_APP_NAME;
}

export function teamsAppManifestTemplate(opts: TeamsAppManifestOptions = {}): string {
  const name = teamsManifestAppName(opts);
  const fullNamed = `${name} — autonomous teammate`;
  const host = TEAMS_DEPLOY_HOST_PLACEHOLDER;
  return JSON.stringify(
    {
      $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
      manifestVersion: "1.17",
      version: TEAMS_APP_MANIFEST_VERSION,
      id: "{{MICROSOFT_APP_ID}}",
      developer: {
        name: "{{DEVELOPER_NAME}}",
        websiteUrl: `https://${host}`,
        privacyUrl: `https://${host}/privacy`,
        termsOfUseUrl: `https://${host}/terms`,
      },
      name: {
        short: name,
        full: fullNamed.length <= TEAMS_APP_FULL_NAME_MAX ? fullNamed : name,
      },
      description: {
        short: "An autonomous teammate with per-conversation memory.",
        full:
          `${name} runs as a Microsoft Teams bot: @mention it in a team channel, drop it into a group chat, or DM it 1:1. ` +
          "It acts under one bot identity shared by this deployment — never under your account and never with your " +
          "permissions — and its memory is scoped per tenant and per conversation. Learnings stay siloed to a " +
          "conversation until that channel is confirmed team-wide. " +
          "It uses AI to write its replies, and an AI reply can be wrong: check what matters before you act on it.",
      },
      icons: { color: "color.png", outline: "outline.png" },
      accentColor: TEAMS_BRAND_ACCENT_COLOR,
      bots: [
        {
          botId: "{{MICROSOFT_APP_ID}}",
          scopes: ["team", "groupChat", "personal"],
          supportsFiles: false,
          isNotificationOnly: false,
          supportsCalling: false,
          supportsVideo: false,
          commandLists: teamsCommandLists(opts.commandName ?? TEAMS_DEFAULT_COMMAND_NAME),
        },
      ],
      permissions: ["identity", "messageTeamMembers"],
      webApplicationInfo: { id: "{{MICROSOFT_APP_ID}}", resource: `api://${host}/{{MICROSOFT_APP_ID}}` },
      authorization: {
        permissions: {
          resourceSpecific: [
            { name: "ChannelMessage.Read.Group", type: "Application" },
            { name: "ChatMessage.Read.Chat", type: "Application" },
            { name: "ChannelMember.Read.Group", type: "Application" },
          ],
        },
      },
      validDomains: [host],
    },
    null,
    2,
  );
}

export const TEAMS_APP_CONSOLE_URL = "https://admin.teams.microsoft.com";

export const TEAMS_APP_MANIFEST_STEPS: readonly string[] = [
  "Save the manifest below as manifest.json in the teams-app/ directory, beside color.png and outline.png.",
  "Keep color.png and outline.png unless you set identity.name and chose your own icon: they are the project mark, the default avatar. A checkout without teams-app/ gets both from https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/teams-app/color.png and https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/teams-app/outline.png. To use your own icon, replace both (color 192x192; outline 32x32, white on transparent).",
  "Replace {{MICROSOFT_APP_ID}} with the Azure Bot's Application (client) ID (the teams.appId setting) — it appears three times and must match everywhere.",
  "Replace {{DEVELOPER_NAME}} with your org's name.",
  "Zip it flat: zip -j app.zip manifest.json color.png outline.png (Teams requires the manifest at the zip root).",
  "Upload it: Teams → Apps → Manage your apps → Upload a custom app for one team, or the Teams Admin Center → Manage apps → Upload new app for the org.",
];

export const TEAMS_APP_MANIFEST_COLLECT: readonly string[] = [
  "Azure Bot → Configuration → Microsoft App ID = the teams.appId setting (agent/settings/settings.ts)",
  "The app registration's client secret = MICROSOFT_APP_PASSWORD",
  "The Entra tenant id = MICROSOFT_TENANT_ID",
];
