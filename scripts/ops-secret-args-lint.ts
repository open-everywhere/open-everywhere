import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_CONFIG_NAMES } from "../packages/core/agent/ops/quickstart.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES_FIXED = [
  "packages/create/template/claude/skills/quickstart-open-everywhere/SKILL.md",
  ".claude/skills/quickstart-open-everywhere/SKILL.md",
  "packages/create/template/AGENTS.md",
];

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

function argumentSpan(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

const ALLOWED = new Set<string>(ENV_CONFIG_NAMES);

export function scan(text: string): string[] {
  const problems: string[] = [];
  const call = /\b(scaffold_env|secret_set)\b\s*`?\s*\(?\s*(\{)/g;
  for (let m = call.exec(text); m !== null; m = call.exec(text)) {
    const open = m.index + m[0].length - 1;
    const args = argumentSpan(text, open);
    const line = text.slice(0, m.index).split("\n").length;
    if (/["']?\bsecrets["']?\s*:/.test(args)) problems.push(`line ${line}: ${m[1]} with a \`secrets\` map — the tool takes names, never values`);
    for (const pair of args.matchAll(/["']?\b([A-Z][A-Z0-9_]*)\b["']?\s*:\s*[^\s{\[]/g)) {
      if (!ALLOWED.has(pair[1]!)) problems.push(`line ${line}: ${m[1]} passes a value for ${pair[1]} — a secret goes through \`npx oe env set ${pair[1]}\` in the person's own terminal`);
    }
  }
  return problems;
}

const KNOWN_BAD = [
  'scaffold_env { "values": { "SLACK_BOT_TOKEN": "<xoxb-…>" } }',
  "`scaffold_env { values: { DATABASE_URL: \"<the connection string>\" } }`",
  'secret_set { "secrets": { "ACME_API_TOKEN": "<the token>" } }',
  "scaffold_env { values: { SLACK_BOT_TOKEN: xoxb-123 } }",
  'scaffold_env({ values: { "DATABASE_URL": "postgres://u:p@h/db" } })',
];
const KNOWN_GOOD = ['scaffold_env { "secretNames": ["SLACK_BOT_TOKEN"] }', 'scaffold_env { "values": { "OE_PUBLIC_BASE_URL": "https://x" } }', 'secret_set { "names": ["ACME_API_TOKEN"] }'];
const controlFailures = [
  ...KNOWN_BAD.filter((sample) => scan(sample).length === 0).map((s) => `the scanner missed a known-bad sample: ${s}`),
  ...KNOWN_GOOD.filter((sample) => scan(sample).length > 0).map((s) => `the scanner flagged a known-good sample: ${s}`),
];
if (controlFailures.length > 0) {
  for (const f of controlFailures) console.error(`✗ ops-secret-args: ${f}`);
  process.exit(1);
}

const files = [
  ...walk(join(root, "docs"), (p) => p.endsWith(".md")),
  ...walk(join(root, "packages/create/src/steps"), (p) => p.endsWith(".ts")),
  ...FILES_FIXED.map((f) => join(root, f)),
];
const reds: string[] = [];
for (const file of files) {
  for (const problem of scan(readFileSync(file, "utf8"))) reds.push(`${relative(root, file)} ${problem}`);
}
if (reds.length > 0) {
  for (const r of reds) console.error(`✗ ${r}`);
  console.error(`✗ ops-secret-args: ${reds.length} tool-call example(s) put a secret value in an ops tool call.`);
  process.exit(1);
}
console.log(`✓ ops-secret-args: ${files.length} files, no ops tool-call example carries a secret value`);
