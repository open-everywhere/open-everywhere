import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildOpsServer } from "../agent/ops/server.js";

const server = buildOpsServer();
await server.connect(new StdioServerTransport());
process.stderr.write("open-everywhere-ops MCP server ready on stdio (preflight · quickstart · scaffold_env · secret_set/list/rm)\n");
