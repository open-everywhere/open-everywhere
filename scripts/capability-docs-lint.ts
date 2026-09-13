import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCapabilityDocs, docCodeSpans } from "@open-everywhere/core/agent/docs/capability-map.js";
import { isCompiledDoc } from "@open-everywhere/core/agent/docs/source-map.js";
import { TOOL_CONSEQUENCE } from "@open-everywhere/core/agent/access/consequence.js";
import { readMountedToolNames } from "./read-mounted-tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function docPaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(join(root, "docs"));
  return out.filter(isCompiledDoc).sort();
}

const toolNames = await readMountedToolNames(root);

const registered = new Set(Object.keys(TOOL_CONSEQUENCE));
const drift = [
  ...toolNames.filter((n) => !registered.has(n)).map((n) => `mounted tool "${n}" has no TOOL_CONSEQUENCE row`),
  ...[...registered].filter((n) => !toolNames.includes(n)).sort().map((n) => `TOOL_CONSEQUENCE registers "${n}" but no such tool is mounted`),
];
if (drift.length > 0) {
  console.error(
    `✗ capability-docs-lint: the mounted tool surface and the consequence registry disagree (${drift.length}) — ` +
      `fix that first (\`npm run lint:consequence\`), because until they agree neither lint's totality claim is true:\n` +
      drift.map((d) => `  - ${d}`).join("\n"),
  );
  process.exit(1);
}

const docs = docPaths().map((path) => ({ path, spans: docCodeSpans(readFileSync(join(root, path), "utf8")) }));
const report = checkCapabilityDocs({ toolNames, docs });

if (report.problems.length > 0) {
  console.error(`✗ capability-docs-lint: ${report.problems.length} problem(s):\n` + report.problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

const pages = new Set(report.documented.flatMap((n) => report.coverage.get(n) ?? []));
console.log(
  `✓ capability-docs-lint: ${report.documented.length}/${toolNames.length} mounted tools documented across ${pages.size} of ${docs.length} pages, ` +
    `${report.exempted.length} declared non-capabilities (UNDOCUMENTED_TOOLS). ` +
    `Connector/MCP ops and the injected browser_* family are runtime-injected planes, out of scope by construction.`,
);
