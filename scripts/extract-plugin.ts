import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parsePluginDir } from "../agent/plugins/parse.js";
import { extractPlugin } from "../agent/plugins/extract.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const outIdx = args.indexOf("--out");
const root = outIdx >= 0 ? resolve(args[outIdx + 1]) : process.cwd();
const dir = args.find((a) => !a.startsWith("--") && a !== (outIdx >= 0 ? args[outIdx + 1] : undefined));

if (!dir) {
  console.error("usage: tsx scripts/extract-plugin.ts <plugin-dir> [--write] [--out <project-root>]");
  process.exit(1);
}

const plugin = parsePluginDir(resolve(dir));
const { files, report } = extractPlugin(plugin);

console.log(`\nPlugin: ${plugin.manifest.name}${plugin.manifest.version ? ` v${plugin.manifest.version}` : ""}`);
console.log(`  skills:           ${report.skills.length}`);
console.log(`  commands→skills:  ${report.commandsAsSkills.length}`);
console.log(`  connectors:       ${report.connectors.length}`);
console.log(`  subagents:        ${report.subagents.length}`);
for (const n of report.notes) console.log(`  note: ${n}`);
for (const m of report.manual) console.log(`  MANUAL (${m.kind} "${m.name}"): ${m.reason}`);

console.log();
for (const f of files) console.log(`  ${write ? "write" : "would write"}: ${f.path}`);

if (write) {
  for (const f of files) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf-8");
  }
  console.log(`\n✓ wrote ${files.length} files under ${root}\n`);
} else {
  console.log(`\n(dry run — pass --write to emit ${files.length} files)\n`);
}
