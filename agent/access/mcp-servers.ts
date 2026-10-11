import { defineMcpServers } from "@open-everywhere/core/agent/connections/mcp-servers.js";
import { slackAsYou } from "@open-everywhere/provider-slack/agent/slack-as-you.js";

export const MCP_SERVERS = defineMcpServers([
  slackAsYou({ clientId: "0000000000000.0000000000000", people: { groups: ["slack-as-you-pilot"] } }),

]);
