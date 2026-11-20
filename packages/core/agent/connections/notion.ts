import { defineConnectorMount } from "./connector-mount.js";
import { mcpConnectionMountSpec } from "./mcp-server-connection.js";

const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

export const NOTION_OAUTH_HOME_REF = "mcp.notion.com/notion-mcp";

/** The Notion connector mount's spec: its URL, its gated auth resolver and its approval policy. */
export const NOTION_MOUNT = mcpConnectionMountSpec({
  name: "notion",
  url: NOTION_MCP_URL,
  signIn: { homeRef: NOTION_OAUTH_HOME_REF, declaration: { mode: "discovery-dcr-pkce", resource: NOTION_MCP_URL } },
  fallback: { secretRef: "NOTION_API_KEY", broker: "env" },
  description:
    "Notion workspace (MCP): search and read pages/databases, AND — when the connected " +
    "integration has edit access — create/update pages and append blocks. This is the team's " +
    "read/WRITE knowledge base: answer questions grounded in it, and record durable notes back " +
    "into the page/database a channel points you at. Append under the right heading; don't " +
    "rewrite whole pages. Notion's API owns the block model, so there's no markdown round-trip.",
});

export default defineConnectorMount(NOTION_MOUNT);
