import { defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";
import { assertConnectorGranted } from "../access/connector-scope.js";

const NOTION_MCP_URL = "https://mcp.notion.com/sse";

export default defineMcpClientConnection({
  url: NOTION_MCP_URL,
  description:
    "Notion workspace (MCP): search pages/databases and read content the connected " +
    "integration can see. Use it to answer questions grounded in the team's Notion docs.",

  auth: {
    principalType: "app",
    async getToken() {
      await assertConnectorGranted("notion");

      const token = process.env.NOTION_API_KEY;
      if (!token) {
        throw new Error(
          'connection "notion": NOTION_API_KEY is not set (provision a Notion ' +
            "internal-integration token, or swap getToken for Vercel Connect — see this file)",
        );
      }
      return { token };
    },
  },

  approval: once(),
});
