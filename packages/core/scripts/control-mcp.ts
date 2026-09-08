import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildControlServer } from "../agent/control/server.js";
import { deploymentOrg } from "../agent/identity/deployment-identity.js";
import { connectOperatorStoreForCli } from "./operator-store-connect.js";

const target = await connectOperatorStoreForCli();

const server = buildControlServer({ includeWrites: true, actor: "local-operator" });
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `open-everywhere-control MCP server ready on stdio (read + write tools) — store: ${target.label}, org: ${deploymentOrg()}\n`,
);
