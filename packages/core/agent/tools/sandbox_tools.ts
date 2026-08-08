import { defineTool } from "eve/tools";
import { bash, glob, grep, readFile, writeFile, webFetch } from "eve/tools/defaults";
import { withStallGuard } from "../stall/guard.js";
import { withBashHangGuard } from "../stall/bash-hang-guard.js";
import { windowGatedKit } from "../access/window-gated.js";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { withEgressFence } from "../access/web-fetch-fence.js";

interface WebFetchOutput {
  content: string;
  contentType: string;
  truncated: boolean;
  url: string;
}

export default windowGatedKit("sandbox_tools", {
  bash: defineTool(withStallGuard("bash", withBashHangGuard(bash))),
  glob: defineTool(withStallGuard("glob", glob)),
  grep: defineTool(withStallGuard("grep", grep)),
  read_file: defineTool(withStallGuard("read_file", readFile)),
  write_file: defineTool(withStallGuard("write_file", writeFile)),
  web_fetch: defineTool({
    ...withStallGuard("web_fetch", withEgressFence("web_fetch", webFetch)),
    toModelOutput(output: unknown) {
      const o = output as WebFetchOutput;
      return ingestUntrustedModelOutput(o.content, {
        source: `web_fetch ${o.url}${o.truncated ? " (truncated)" : ""}`,
        ingestion: { kind: "web", label: "web_fetch" },
      });
    },
  }),
});
