import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildControlServer } from "../agent/control/server.js";
import { connectOperatorStore, loadRootOfTrustEnv } from "./operator-store-connect.js";

const rootEnvFlag = process.argv.indexOf("--root-env");
loadRootOfTrustEnv(resolve(rootEnvFlag >= 0 ? (process.argv[rootEnvFlag + 1] ?? ".env.local") : ".env.local"));

const target = await connectOperatorStore();

const server = buildControlServer({ includeWrites: true, actor: "local-operator" });
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`open-everywhere-control MCP server ready on stdio (read + write tools) — store: ${target.label}\n`);
