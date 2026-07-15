import { defineTool } from "eve/tools";
import { bash, glob, grep, readFile, writeFile, webFetch } from "eve/tools/defaults";
import { withStallGuard } from "../stall/guard.js";
import { windowGatedKit } from "../access/window-gated.js";

export default windowGatedKit("sandbox_tools", {
  bash: defineTool(withStallGuard("bash", bash)),
  glob: defineTool(withStallGuard("glob", glob)),
  grep: defineTool(withStallGuard("grep", grep)),
  read_file: defineTool(withStallGuard("read_file", readFile)),
  write_file: defineTool(withStallGuard("write_file", writeFile)),
  web_fetch: defineTool(withStallGuard("web_fetch", webFetch)),
});
