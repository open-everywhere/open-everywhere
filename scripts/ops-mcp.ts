import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildOpsServer } from "@open-everywhere/core/agent/ops/server.js";
import { registerSlackOps } from "@open-everywhere/provider-slack/agent/ops.js";
import { registerTeamsOps } from "@open-everywhere/provider-teams/agent/ops.js";

registerSlackOps();
registerTeamsOps();

const server = buildOpsServer();
await server.connect(new StdioServerTransport());
process.stderr.write("open-everywhere-ops MCP server ready on stdio (preflight · quickstart · scaffold_env · secret_set/list/rm)\n");
