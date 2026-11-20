import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";
import { glob } from "eve/tools/glob";
import { grep } from "eve/tools/grep";
import { readFile } from "eve/tools/read_file";
import { writeFile } from "eve/tools/write_file";
import { editFile } from "eve/tools/edit_file";
import { webFetch } from "eve/tools/web_fetch";
import { withStallGuard } from "../stall/guard.js";
import { withBashHangGuard } from "../stall/bash-hang-guard.js";
import { windowGatedKit } from "../access/window-gated.js";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { withEgressFence } from "../access/web-fetch-reach.js";
import { withMemoryWriteFence } from "../memory/write-fence.js";
import { bashModelOutput } from "../access/skill-envelope.js";

interface WebFetchOutput {
  content: string;
  contentType: string;
  truncated: boolean;
  url: string;
}

export default windowGatedKit("sandbox_tools", {
  bash: defineTool({
    ...withStallGuard("bash", withBashHangGuard(bash)),
    toModelOutput: bashModelOutput,
  }),
  glob: defineTool(withStallGuard("glob", glob)),
  grep: defineTool(withStallGuard("grep", grep)),
  read_file: defineTool(withStallGuard("read_file", readFile)),
  write_file: defineTool(withStallGuard("write_file", withMemoryWriteFence("write_file", writeFile))),
  edit_file: defineTool(withStallGuard("edit_file", withMemoryWriteFence("edit_file", editFile, "path"))),
  web_fetch: defineTool({
    ...withStallGuard("web_fetch", withEgressFence("web_fetch", webFetch)),
    toModelOutput(output: unknown) {
      const o = output as WebFetchOutput;
      return ingestUntrustedModelOutput(o.content, {
        source: `web_fetch ${o.url}${o.truncated ? " (truncated)" : ""}`,
        toolName: "web_fetch",
      });
    },
  }),
});
