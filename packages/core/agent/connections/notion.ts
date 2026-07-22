import { defineMcpClientConnection } from "eve/connections";
import { connectorApprovalPolicy } from "./connector-auth.js";
import { selectConnectorTransport } from "./connector-transport.js";

const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

const transport = selectConnectorTransport({
  connector: "notion",
  provider: "notion",
  directUrl: NOTION_MCP_URL,
  fallbackSecretRef: "NOTION_API_KEY",
  fallbackBroker: "env",
  executorCredentialId: "user-oauth-executor",
});

export default defineMcpClientConnection({
  url: transport.url,
  description:
    "Notion workspace (MCP): search and read pages/databases, AND — when the connected " +
    "integration has edit access — create/update pages and append blocks. This is the team's " +
    "read/WRITE knowledge base: answer questions grounded in it, and record durable notes back " +
    "into the page/database a channel points you at. Append under the right heading; don't " +
    "rewrite whole pages. Notion's API owns the block model, so there's no markdown round-trip.",

  auth: transport.auth,

  approval: connectorApprovalPolicy(),
});
