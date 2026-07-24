import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildOpsServer } from "@open-everywhere/core/agent/ops/server.js";
import { registerSlackOps } from "@open-everywhere/provider-slack/agent/ops.js";

registerSlackOps();

const server = buildOpsServer();
await server.connect(new StdioServerTransport());
process.stderr.write("open-everywhere-ops MCP server ready on stdio (preflight · quickstart · scaffold_env)\n");
