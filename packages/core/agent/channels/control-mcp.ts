import { defineChannel, DELETE, GET, POST } from "eve/channels";
import { CONTROL_MCP_PATH, handleControlMcpRequest } from "../control/mcp-route.js";
import { CONTROL_PROTECTED_RESOURCE_METADATA_PATH } from "../control/oauth-resource.js";
import {
  CONTROL_OAUTH_AUTHORIZE_PATH,
  CONTROL_OAUTH_SERVER_METADATA_PATH,
  CONTROL_OAUTH_TOKEN_PATH,
  handleAuthorize,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  handleToken,
} from "../control/oauth-route.js";

export default defineChannel({
  routes: [
    GET(CONTROL_OAUTH_SERVER_METADATA_PATH, async (req) => handleAuthorizationServerMetadata(req)),
    GET(CONTROL_PROTECTED_RESOURCE_METADATA_PATH, async (req) => handleProtectedResourceMetadata(req)),
    GET(CONTROL_OAUTH_AUTHORIZE_PATH, async (req) => handleAuthorize(req)),
    POST(CONTROL_OAUTH_TOKEN_PATH, async (req) => handleToken(req)),
    POST(CONTROL_MCP_PATH, async (req) => handleControlMcpRequest(req)),
    GET(CONTROL_MCP_PATH, async (req) => handleControlMcpRequest(req)),
    DELETE(CONTROL_MCP_PATH, async (req) => handleControlMcpRequest(req)),
  ],
});
