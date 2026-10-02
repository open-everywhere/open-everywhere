import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildOpsServer } from "../agent/ops/server.js";

const server = buildOpsServer();
await server.connect(new StdioServerTransport());
process.stderr.write("open-everywhere-ops MCP server ready on stdio (preflight · scaffold_env · scaffold_credential_key · secret_set/list/rm)\n");
