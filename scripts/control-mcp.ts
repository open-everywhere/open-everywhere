import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildControlServer } from "../agent/control/server.js";

const server = buildControlServer();
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("open-everywhere-control MCP server ready on stdio (read-only)\n");
