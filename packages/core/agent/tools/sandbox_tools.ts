import { defineTool } from "eve/tools";
import { bash, type BashToolOutput } from "eve/tools/bash";
import { glob } from "eve/tools/glob";
import { grep } from "eve/tools/grep";
import { readFile } from "eve/tools/read_file";
import { writeFile } from "eve/tools/write_file";
import { webFetch } from "eve/tools/web_fetch";
import { withStallGuard } from "../stall/guard.js";
import { withBashHangGuard } from "../stall/bash-hang-guard.js";
import { windowGatedKit } from "../access/window-gated.js";
import { ingestUntrusted, ingestUntrustedModelOutput } from "../access/untrusted.js";
import { withEgressFence } from "../access/web-fetch-reach.js";
import { withMemoryWriteFence } from "../memory/write-fence.js";
import { extractSkillEnvelopes, sanitizeSkillEnvelopeSource } from "../access/skill-taint-envelope.js";

interface WebFetchOutput {
  content: string;
  contentType: string;
  truncated: boolean;
  url: string;
}

type BashOutput = BashToolOutput;

export function bashModelOutput(output: unknown): { type: "json"; value: unknown } {
  const o = output as BashOutput;
  const stdout = typeof o?.stdout === "string" ? o.stdout : "";
  const segments = extractSkillEnvelopes(stdout);
  if (!segments.some((s) => s.untrusted)) {
    return { type: "json", value: output };
  }
  const rebuiltStdout = segments
    .map((s) => {
      if (!s.untrusted) return s.text;
      const label = sanitizeSkillEnvelopeSource(s.source);
      return ingestUntrusted(s.content, {
        source: `skill-declared ${label}`,
        ingestion: { kind: "skill-declared", label },
      });
    })
    .join("");
  return { type: "json", value: { ...o, stdout: rebuiltStdout } };
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
