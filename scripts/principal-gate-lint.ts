import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPrincipalGates,
  findPrincipalGates,
  type PrincipalGate,
} from "@open-everywhere/core/agent/access/principal-gate-manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const listOnly = process.argv.includes("--list");

function tsFilesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const roots = [join(root, "packages", "core", "agent")];
const providersDir = join(root, "packages", "providers");
try {
  for (const p of readdirSync(providersDir)) {
    const agentDir = join(providersDir, p, "agent");
    try {
      if (statSync(agentDir).isDirectory()) roots.push(agentDir);
    } catch {
    }
  }
} catch {
}

const files = roots.flatMap((r) => tsFilesUnder(r));
if (files.length === 0) {
  console.error(`✗ principal-gate-lint: found no sources under ${roots.map((r) => relative(root, r)).join(", ")} — refusing to report clean against an unread tree`);
  process.exit(1);
}

const gates: PrincipalGate[] = files.flatMap((f) => findPrincipalGates(relative(root, f), readFileSync(f, "utf8")));

if (listOnly) {
  for (const g of [...gates].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))) {
    const verdict = g.intent ?? g.unknownIntent ?? "UNMARKED";
    console.log(`${verdict.toUpperCase().padEnd(15)} ${g.file}:${g.line}  ${g.expr.padEnd(16)} ${g.reason ?? ""}`);
  }
  console.log(`\n${gates.length} principal refusal gate(s) over ${files.length} source file(s).`);
  process.exit(0);
}

const defects = checkPrincipalGates(gates);
if (defects.length > 0) {
  console.error(`✗ principal-gate-lint: ${defects.length} undeclared or contradictory principal gate(s):`);
  for (const d of defects) console.error(`  - [${d.rule}] ${d.file}:${d.line} — ${d.message}`);
  console.error(
    `\n  Why this is a hard error: a "presence" gate written against the BOUND principal refuses nobody, because a\n` +
      `  triggered routine fire binds as its routine's attested creator — a real person's id. That exact shape shipped\n` +
      `  three times (OPE-269, OPE-272, OPE-273). The marker is how the choice stops being implicit.`,
  );
  process.exit(1);
}

const presence = gates.filter((g) => g.intent === "presence").length;
console.log(
  `✓ principal-gate-lint: ${gates.length} principal refusal gate(s), every one declaring its intent and reading an accessor that can deliver it ` +
    `(${presence} presence — refuse an unattended fire; ${gates.length - presence} accountability — somebody nameable must exist).`,
);
