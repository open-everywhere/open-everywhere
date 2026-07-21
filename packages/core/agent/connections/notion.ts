import { defineMcpClientConnection } from "eve/connections";
import { appProviderToken, userAwareProviderToken, connectorApprovalPolicy } from "./connector-auth.js";
import { connectorUserPrincipalEnabled } from "./connector-flags.js";

const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

export default defineMcpClientConnection({
  url: NOTION_MCP_URL,
  description:
    "Notion workspace (MCP): search and read pages/databases, AND — when the connected " +
    "integration has edit access — create/update pages and append blocks. This is the team's " +
    "read/WRITE knowledge base: answer questions grounded in it, and record durable notes back " +
    "into the page/database a channel points you at. Append under the right heading; don't " +
    "rewrite whole pages. Notion's API owns the block model, so there's no markdown round-trip.",

  auth: connectorUserPrincipalEnabled()
    ? userAwareProviderToken({ connector: "notion", fallbackSecretRef: "NOTION_API_KEY" })
    : appProviderToken({ connector: "notion", fallbackSecretRef: "NOTION_API_KEY" }),

  approval: connectorApprovalPolicy(),
});
