import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrincipalKeyDefects, findComposerDeclarations, PRINCIPAL_KEY_MODULE, type ComposerDeclaration, type PrincipalKeyDefect } from "@open-everywhere/core/agent/identity/principal-key-rules.js";

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
for (const group of ["providers", "adapters"]) {
  const dir = join(root, "packages", group);
  try {
    for (const p of readdirSync(dir)) {
      const agentDir = join(dir, p, "agent");
      try {
        if (statSync(agentDir).isDirectory()) roots.push(agentDir);
      } catch {
      }
    }
  } catch {
  }
}

const files = roots.flatMap((r) => tsFilesUnder(r));
if (files.length === 0) {
  console.error(`✗ principal-key-lint: found no sources under ${roots.map((r) => relative(root, r)).join(", ")} — refusing to report clean against an unread tree`);
  process.exit(1);
}

const defects: PrincipalKeyDefect[] = [];
const composers: ComposerDeclaration[] = [];
for (const f of files) {
  const rel = relative(root, f).replace(/\\/g, "/");
  const src = readFileSync(f, "utf8");
  defects.push(...findPrincipalKeyDefects(rel, src));
  composers.push(...findComposerDeclarations(rel, src));
}

if (listOnly) {
  for (const c of composers) console.log(`COMPOSER  ${c.file}:${c.line}`);
  for (const d of defects) console.log(`${d.rule.toUpperCase().padEnd(13)} ${d.file}:${d.line}  ${d.excerpt}`);
  console.log(`\n${composers.length} composer declaration(s), ${defects.length} defect(s) over ${files.length} source file(s).`);
  process.exit(0);
}

const problems: string[] = [];
if (composers.length !== 1) {
  problems.push(`expected exactly ONE principalKey composer, found ${composers.length}${composers.length ? ` (${composers.map((c) => `${c.file}:${c.line}`).join(", ")})` : ""}`);
} else if (composers[0]!.file !== PRINCIPAL_KEY_MODULE) {
  problems.push(`the principalKey composer is at ${composers[0]!.file}, not ${PRINCIPAL_KEY_MODULE} — the grammar's owning module is where it belongs`);
}

if (defects.length > 0 || problems.length > 0) {
  console.error(`✗ principal-key-lint: ${defects.length} defect(s)${problems.length ? ` + ${problems.length} tree-level problem(s)` : ""}:`);
  for (const p of problems) console.error(`  - [composer] ${p}`);
  for (const d of defects) console.error(`  - [${d.rule}] ${d.file}:${d.line} — ${d.message}`);
  console.error(
    "\n  Why this is a hard error: a hand-rolled key is byte-identical TODAY, so nothing fails and nobody notices —\n" +
      "  until the grammar gains its tenant rung (OPE-309 phase 1), when the copy keeps emitting the old shape and a\n" +
      "  qualified-vs-unqualified mismatch silently matches nobody. The first run of this lint found six real ones.",
  );
  process.exit(1);
}

console.log(
  `✓ principal-key-lint: ONE composer (${PRINCIPAL_KEY_MODULE}), no hand-rolled principal-key composition and no unqualifying normaliser ` +
    `across ${files.length} source file(s) in ${roots.length} agent tree(s).`,
);
