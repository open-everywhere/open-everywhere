import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildOpsServer } from "@open-everywhere/core/agent/ops/server.js";
import { registerSlackOps } from "@open-everywhere/provider-slack/agent/ops.js";
import { registerTeamsOps } from "@open-everywhere/provider-teams/agent/ops.js";
import { registerDiscordOps } from "@open-everywhere/provider-discord/agent/ops.js";
import { registerGithubOps } from "@open-everywhere/provider-github/agent/ops.js";
import { registerSurfaceTrustPreflight } from "@open-everywhere/core/agent/identity/trust-preflight.js";
import "../agent/identity/surfaces.js";

registerSlackOps();
registerTeamsOps();
registerDiscordOps();
registerGithubOps();
registerSurfaceTrustPreflight();

const server = buildOpsServer();
await server.connect(new StdioServerTransport());
process.stderr.write("open-everywhere-ops MCP server ready on stdio (preflight · quickstart · scaffold_env · scaffold_credential_key · secret_set/list/rm)\n");
