import type { ProviderEventDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const TEAMS_PROVIDER_EVENTS: ProviderEventDeclaration = {
  doc: "https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage",
  events: [
    {
      event: "/teams/{team-id}/channels/{channel-id}/messages",
      routing: "none",
      match: [],
      scope: [],
      note: "messages and replies in ONE channel; changeType `created,updated`. The narrowest Teams subscription there is, and the one a per-channel routine would want",
    },
    {
      event: "/chats/{chat-id}/messages",
      routing: "none",
      match: [],
      scope: [],
      note: "messages in ONE chat; changeType `created,updated`",
    },
    {
      event: "/teams/getAllMessages",
      routing: "none",
      match: [],
      scope: [],
      note: "every channel message in the TENANT; changeType `created,updated`. Tenant-wide, so it needs the `ChannelMessage.Read.All` application permission",
    },
    {
      event: "/chats/getAllMessages",
      routing: "none",
      match: [],
      scope: [],
      note: "every chat message in the TENANT; changeType `created,updated,deleted`. Needs `Chat.Read.All`",
    },
    {
      event: "/users/{user-id}/chats/getAllMessages",
      routing: "none",
      match: [],
      scope: [],
      note: "every chat message one user takes part in; changeType `created,updated,deleted`",
    },
    {
      event: "/appCatalogs/teamsApps/{teams-app-id}/installedToChats/getAllMessages",
      routing: "none",
      match: [],
      scope: [],
      note: "every chat message where a named Teams app is installed; changeType `created,updated`. The narrowest tenant-wide shape — it follows the app rather than the tenant",
    },
  ],
};
