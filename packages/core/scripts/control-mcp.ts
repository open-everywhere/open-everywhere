import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildControlServer } from "../agent/control/server.js";
import { deploymentOrg } from "../agent/identity/deployment-identity.js";
import { connectOperatorDirectory, connectOperatorStoreForCli } from "./operator-store-connect.js";
import { resolveTranscriptSource } from "./control-transcript-source.js";

const target = await connectOperatorStoreForCli();

const directory = await connectOperatorDirectory();

const transcripts = resolveTranscriptSource();

const server = buildControlServer({
  includeWrites: true,
  actor: "local-operator",
  ...(transcripts.reader ? { readTranscript: transcripts.reader } : {}),
});
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `open-everywhere-control MCP server ready on stdio (read + write tools) — store: ${target.label}, org: ${deploymentOrg()}\n`,
);
process.stderr.write(
  transcripts.reader
    ? `  session_transcript reads from ${transcripts.baseUrl}\n`
    : `  session_transcript is unconfigured — set ${transcripts.missing.join(" and ")}\n`,
);
if (directory.provider) {
  process.stderr.write(`  directory verbs read from the ${directory.provider} adapter\n`);
} else if (directory.unloaded) {
  process.stderr.write(`  directory verbs are unarmed — ${directory.unloaded}\n`);
}
