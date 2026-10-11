import type { McpServerDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const SLACK_AS_YOU_NAME = "slack-as-you";

export const SLACK_MCP_URL = "https://mcp.slack.com/mcp";

const SLACK_USER_AUTHORIZE_URL = "https://slack.com/oauth/v2_user/authorize";

const SLACK_USER_ACCESS_URL = "https://slack.com/api/oauth.v2.user.access";

export const SLACK_AS_YOU_SECRET_REF = "db:slack:oauth-client-secret";

export const SLACK_MCP_BOT_SCOPE = "mcp:connect";

export const SLACK_AS_YOU_SCOPES = {
  search: ["search:read.public", "search:read.private", "search:read.mpim", "search:read.im", "search:read.files", "search:read.users", "files:read"],
  read: ["channels:history", "groups:history", "mpim:history", "im:history", "canvases:read", "users:read"],
  write: ["chat:write"],
} as const satisfies Record<string, readonly string[]>;

export type SlackAsYouToolGroup = keyof typeof SLACK_AS_YOU_SCOPES;

export function slackAsYouUserScopes(groups: readonly SlackAsYouToolGroup[] = ["search", "read", "write"]): readonly string[] {
  const out: string[] = [];
  for (const group of ["search", "read", "write"] as const) {
    if (!groups.includes(group)) continue;
    for (const scope of SLACK_AS_YOU_SCOPES[group]) if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

export interface SlackAsYouOptions {
  readonly clientId: string;
  readonly clientSecretRef?: string;
  readonly clientSecretBroker?: string;
  readonly tools?: readonly SlackAsYouToolGroup[];
  readonly people?: McpServerDeclaration["people"];
}

export function slackAsYou(opts: SlackAsYouOptions): McpServerDeclaration {
  const groups = opts.tools ?? (["search", "read", "write"] as const);
  return {
    name: SLACK_AS_YOU_NAME,
    url: SLACK_MCP_URL,
    description:
      "Search Slack as you: Slack's own MCP server, signed in as the person in this DM. It reads the channels, threads " +
      "and messages THEY can see, including ones the bot is not in" +
      (groups.includes("write") ? ", and it can post in their name (each post takes an approval card)." : "."),
    personalSurface: { platform: "slack", label: "Slack" },
    signIn: {
      mode: "static-confidential",
      authorizationEndpoint: SLACK_USER_AUTHORIZE_URL,
      tokenEndpoint: SLACK_USER_ACCESS_URL,
      clientId: opts.clientId,
      clientSecretRef: opts.clientSecretRef ?? SLACK_AS_YOU_SECRET_REF,
      ...(opts.clientSecretBroker !== undefined ? { clientSecretBroker: opts.clientSecretBroker } : {}),
      bodyEncoding: "form",
      scopes: [slackAsYouUserScopes(groups).join(",")],
    },
    ...(opts.people !== undefined ? { people: opts.people } : {}),
  };
}
