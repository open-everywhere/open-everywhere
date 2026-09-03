#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast";

import { lineClasses } from "./loc.mjs";

function projectRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}

const ROOT = projectRoot();

export const SOURCE_EXTENSIONS = [".ts", ".mts", ".mjs", ".js"];

const SKIP_DIRS = new Set([".git", ".claude", "node_modules", "dist", "build", "coverage", ".eve", ".next", ".vercel", ".turbo"]);

export const DIRECTIVE_MARKERS = [
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "eslint-disable",
  "eslint-enable",
  "prettier-ignore",
  "biome-ignore",
  "hosted-inline-exempt",
  "/// <reference",
  "c8 ignore",
  "v8 ignore",
  "istanbul ignore",
  "#region",
  "#endregion",
  "@deprecated",
];

const HISTORY_DATE = /20(2[4-9])-\d\d-\d\d/u;

const HISTORY_WORDS =
  /previously|used to|no longer|historically|bit on|measured|superseded|rescinded|retired|re-strengthened|before OPE-|since OPE-|since PR|after PR|see OPE-\d+ for/iu;

function isRefsOnly(line) {
  const stripped = line
    .replace(/OPE-\d+/gu, " ")
    .replace(/#\d+/gu, " ")
    .replace(/\bPR\b/gu, " ")
    .replace(/[^A-Za-z0-9]/gu, "")
    .trim();
  return stripped.length === 0;
}

function closeIndex(line, from) {
  const at = line.indexOf("*/", from);
  return at === -1 ? -1 : at + 2;
}

export function parseBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) {
      const start = i;
      while (i < lines.length && lines[i].trim().startsWith("//")) i++;
      blocks.push(makeBlock(lines, start, i - 1, "line", -1));
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const start = i;
      const kind = trimmed.startsWith("/**") && trimmed !== "/**/" ? "jsdoc" : "block";
      const openAt = lines[i].indexOf("/*");
      const closedHere = closeIndex(lines[i], openAt + 2);
      if (closedHere !== -1) {
        blocks.push(makeBlock(lines, start, start, kind, closedHere));
        i++;
        continue;
      }
      i++;
      let close = -1;
      while (i < lines.length) {
        close = closeIndex(lines[i], 0);
        if (close !== -1) break;
        i++;
      }
      const end = Math.min(i, lines.length - 1);
      blocks.push(makeBlock(lines, start, end, kind, i < lines.length ? close : -1));
      i = end + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function blockContent(rawLines, kind) {
  const out = rawLines.map((raw) => {
    let line = raw.trim();
    if (kind === "line") return line.replace(/^\/\/+ ?/u, "");
    line = line.replace(/^\/\*\*?/u, "").replace(/\*\/\s*$/u, "");
    line = line.replace(/^\*+ ?/u, "");
    return line.trim();
  });
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

function makeBlock(lines, startIndex, endIndex, kind, closeAt) {
  const rawLines = lines.slice(startIndex, endIndex + 1);
  const last = rawLines.length - 1;
  const tail = closeAt === -1 ? "" : rawLines[last].slice(closeAt).trim();
  if (tail !== "") rawLines[last] = rawLines[last].slice(0, closeAt);
  const raw = rawLines.join("\n");
  const indent = /^[ \t]*/u.exec(lines[startIndex])[0];
  return {
    startIndex,
    endIndex,
    start: startIndex + 1,
    end: endIndex + 1,
    kind,
    indent,
    raw,
    tail,
    content: blockContent(rawLines, kind),
  };
}

export function classifyBlock(block) {
  if (DIRECTIVE_MARKERS.some((marker) => block.raw.includes(marker))) return "directive";
  const lines = block.content.filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "candidate";
  const everyLineIsHistory = lines.every(
    (line) => HISTORY_DATE.test(line) || HISTORY_WORDS.test(line) || isRefsOnly(line),
  );
  return everyLineIsHistory ? "auto-history" : "candidate";
}

function nextCodeAfter(text, block) {
  const lines = text.split("\n");
  const classes = lineClasses(text);
  for (let i = block.endIndex + 1; i < lines.length; i++) {
    if (classes[i] === "code") return lines[i].trim();
  }
  return "";
}

const shortHash = (value) => createHash("sha1").update(value).digest("hex").slice(0, 8);

export function blockId(relPath, block) {
  return `${relPath}:${block.start}:${shortHash(block.raw)}`;
}

export function parseBlockId(id) {
  const m = /^(.*):(\d+):([0-9a-f]{8})$/u.exec(id);
  return m ? { path: m[1], start: Number(m[2]), hash: m[3] } : undefined;
}

export function inventoryFile(relPath, text) {
  const records = [];
  for (const block of parseBlocks(text)) {
    const cls = classifyBlock(block);
    if (cls === "directive") continue;
    if (block.tail !== "") continue;
    records.push({
      id: blockId(relPath, block),
      file: relPath,
      start: block.start,
      end: block.end,
      kind: block.kind,
      text: block.content.join("\n"),
      next_code: nextCodeAfter(text, block),
      class: cls,
    });
  }
  return records;
}

function expandPaths(inputs) {
  const out = [];
  const push = (abs) => {
    if (SOURCE_EXTENSIONS.some((ext) => abs.endsWith(ext))) out.push(abs);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        push(abs);
      }
    }
  };
  for (const input of inputs) {
    const abs = resolve(input);
    if (!existsSync(abs)) fail(`no such path: ${input}`);
    if (statSync(abs).isDirectory()) walk(abs);
    else push(abs);
  }
  return [...new Set(out)].sort();
}

const relToRepo = (abs) => relative(ROOT, abs).split("\\").join("/");

function fail(message) {
  console.error(`✗ tidy/comments: ${message}`);
  process.exit(1);
}

function cmdInventory(argv) {
  const outFlag = argv.indexOf("--out");
  if (outFlag === -1 || !argv[outFlag + 1]) fail("inventory needs `--out <file.jsonl>`");
  const outPath = resolve(argv[outFlag + 1]);
  const paths = argv.filter((a, i) => i !== outFlag && i !== outFlag + 1 && !a.startsWith("--"));
  if (paths.length === 0) fail("inventory needs at least one path");

  const records = [];
  for (const abs of expandPaths(paths)) {
    records.push(...inventoryFile(relToRepo(abs), readFileSync(abs, "utf8")));
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""));

  const byClass = new Map();
  for (const r of records) byClass.set(r.class, (byClass.get(r.class) ?? 0) + 1);
  const summary = [...byClass.entries()].sort().map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`✓ tidy/comments inventory: ${records.length} block(s) → ${outPath}${summary ? ` (${summary})` : ""}`);
}

export function rewrap(text, kind, indent) {
  const lines = text.split("\n").map((l) => l.trim());
  if (kind === "line") return lines.map((l) => (l === "" ? `${indent}//` : `${indent}// ${l}`));
  const open = kind === "jsdoc" ? "/**" : "/*";
  if (lines.length === 1) return [`${indent}${open} ${lines[0]} */`];
  return [`${indent}${open}`, ...lines.map((l) => (l === "" ? `${indent} *` : `${indent} * ${l}`)), `${indent} */`];
}

function collapseBlanksAround(lines, index) {
  let start = index;
  while (start > 0 && lines[start - 1].trim() === "") start--;
  let end = index;
  while (end < lines.length && lines[end].trim() === "") end++;
  if (end - start >= 2) lines.splice(start, end - start, "");
}

function readDecisions(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) fail(`no such decisions file: ${file}`);
  const decisions = [];
  const raw = readFileSync(abs, "utf8").split("\n");
  raw.forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`${file}:${i + 1} is not JSON`);
    }
    if (typeof parsed.id !== "string") fail(`${file}:${i + 1} has no "id"`);
    if (!["keep", "delete", "replace"].includes(parsed.action)) {
      fail(`${file}:${i + 1} has action ${JSON.stringify(parsed.action)} — expected keep, delete or replace`);
    }
    if (parsed.action === "replace" && typeof parsed.text !== "string") {
      fail(`${file}:${i + 1} is a replace with no "text"`);
    }
    decisions.push(parsed);
  });
  return decisions;
}

function cmdApply(argv) {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) fail("apply needs `<decisions.jsonl>`");
  const reapply = argv.includes("--reapply");
  const decisions = readDecisions(file);

  const byFile = new Map();
  for (const decision of decisions) {
    const parsed = parseBlockId(decision.id);
    if (!parsed) fail(`unknown id ${JSON.stringify(decision.id)} — not a <path>:<line>:<hash> block id`);
    const list = byFile.get(parsed.path) ?? [];
    list.push({ ...decision, ...parsed });
    byFile.set(parsed.path, list);
  }

  let deleted = 0;
  let replaced = 0;
  let alreadyApplied = 0;
  let filesChanged = 0;

  for (const [relPath, list] of [...byFile.entries()].sort()) {
    const abs = resolve(ROOT, relPath);
    if (abs !== ROOT && !abs.startsWith(`${ROOT}/`)) fail(`refusing id for ${relPath} — it resolves outside ${ROOT}`);
    if (!existsSync(abs)) fail(`unknown id — ${relPath} does not exist`);
    const original = readFileSync(abs, "utf8");
    const lines = original.split("\n");
    const blocks = parseBlocks(original);

    const edits = [];
    for (const decision of list) {
      const candidates = blocks.filter((b) => shortHash(b.raw) === decision.hash);
      const exact = candidates.find((b) => b.start === decision.start) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!exact) {
        if (candidates.length > 1) fail(`ambiguous id ${decision.id} — ${candidates.length} blocks share that content`);
        if (decision.action === "replace" && blocks.some((b) => b.content.join("\n").trim() === decision.text.trim())) {
          alreadyApplied++;
          continue;
        }
        if (!reapply) {
          fail(
            `unknown id ${decision.id} — no block in ${relPath} carries that content. If this decisions file ` +
              `has already been applied, re-run with --reapply.`,
          );
        }
        alreadyApplied++;
        continue;
      }
      if (classifyBlock(exact) === "directive") {
        fail(`refusing ${decision.action} on ${decision.id} — that block is a DIRECTIVE and is kept verbatim`);
      }
      if (exact.tail !== "") {
        fail(
          `refusing ${decision.action} on ${decision.id} — code follows the closing */ on line ${exact.end}, ` +
            `and editing the block would move it. The inventory never offers such a block.`,
        );
      }
      if (decision.action !== "keep") edits.push({ block: exact, decision });
    }

    if (edits.length === 0) continue;
    edits.sort((a, b) => b.block.startIndex - a.block.startIndex);
    for (const { block, decision } of edits) {
      const span = block.endIndex - block.startIndex + 1;
      if (decision.action === "delete") {
        lines.splice(block.startIndex, span);
        collapseBlanksAround(lines, block.startIndex);
        deleted++;
      } else {
        const wrapped = rewrap(decision.text, block.kind, block.indent);
        lines.splice(block.startIndex, span, ...wrapped);
        collapseBlanksAround(lines, block.startIndex + wrapped.length);
        collapseBlanksAround(lines, block.startIndex);
        replaced++;
      }
    }

    const next = lines.join("\n");
    if (next !== original) {
      writeFileSync(abs, next);
      filesChanged++;
    }
  }

  console.log(
    `✓ tidy/comments apply: ${deleted} deleted, ${replaced} replaced, ${alreadyApplied} already applied, ` +
      `${filesChanged} file(s) written`,
  );
}

const ENDS_AN_EXPRESSION = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

export function codeTokens(text) {
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  const out = [];
  const templates = [];
  let braceDepth = 0;
  let previous;
  let token;
  while ((token = scanner.scan()) !== SyntaxKind.EndOfFile) {
    if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) && !ENDS_AN_EXPRESSION.has(previous)) {
      token = scanner.reScanSlashToken();
    } else if (token === SyntaxKind.OpenBraceToken) {
      braceDepth++;
    } else if (token === SyntaxKind.CloseBraceToken) {
      if (templates.length > 0 && templates[templates.length - 1] === braceDepth) {
        token = scanner.reScanTemplateToken(false);
        if (token === SyntaxKind.TemplateTail) templates.pop();
      } else {
        braceDepth--;
      }
    }
    if (token === SyntaxKind.TemplateHead) templates.push(braceDepth);
    out.push(`${token}:${scanner.getTokenText()}`);
    previous = token;
  }
  return out;
}

function git(args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
    });
  } catch (error) {
    if (allowFailure) return undefined;
    throw error;
  }
}

const directiveLineCount = (text) =>
  text.split("\n").filter((line) => DIRECTIVE_MARKERS.some((marker) => line.includes(marker))).length;

function changedLines(base, relPath) {
  const diff = git(["diff", "--no-color", "-U0", base, "--", relPath]) ?? "";
  const out = [];
  let baseLine = 0;
  let currentLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header) {
      baseLine = Number(header[1]);
      currentLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) out.push({ side: "base", line: baseLine++ });
    else if (line.startsWith("+")) out.push({ side: "current", line: currentLine++ });
  }
  return out;
}

function cmdVerify(argv) {
  const baseFlag = argv.indexOf("--base");
  if (baseFlag === -1 || !argv[baseFlag + 1]) fail("verify needs `--base <git-ref>`");
  const base = argv[baseFlag + 1];
  if (git(["rev-parse", "--verify", `${base}^{commit}`], true) === undefined) fail(`--base ${base} is not a commit`);

  const names = (git(["diff", "--name-only", base, "--"]) ?? "").split("\n").filter((n) => n.trim().length > 0);
  const files = names.filter((n) => SOURCE_EXTENSIONS.some((ext) => n.endsWith(ext)));

  const problems = [];

  for (const name of names) {
    if (!files.includes(name)) {
      problems.push(`${name}: changed, and it is not ${SOURCE_EXTENSIONS.join("/")} — nothing here can prove that comment-only`);
    }
  }
  for (const relPath of files) {
    const abs = join(ROOT, relPath);
    const baseShow = git(["show", `${base}:${relPath}`], true);
    const baseExisted = baseShow !== undefined;
    const baseText = baseShow ?? "";
    const currentText = existsSync(abs) ? readFileSync(abs, "utf8") : "";

    if (baseExisted && currentText === "") {
      problems.push(`${relPath}: the base carries this file and the current text is empty — a deleted or emptied file is never a comment-only change`);
      continue;
    }
    if (baseText === currentText) {
      problems.push(`${relPath}: changed, and the two texts are byte-identical — the change is not in the text (a file mode, or a new empty file), so nothing here can prove it comment-only`);
      continue;
    }

    if (codeTokens(baseText).join("\n") !== codeTokens(currentText).join("\n")) {
      problems.push(`${relPath}: the token stream differs — this change is not comment-only`);
      continue;
    }

    const baseClasses = lineClasses(baseText);
    const currentClasses = lineClasses(currentText);
    for (const { side, line } of changedLines(base, relPath)) {
      const cls = (side === "base" ? baseClasses : currentClasses)[line - 1];
      if (cls !== "comment" && cls !== "blank") {
        problems.push(`${relPath}:${line} (${side}) is a ${cls ?? "missing"} line, and the diff changed it`);
      }
    }

    const before = directiveLineCount(baseText);
    const after = directiveLineCount(currentText);
    if (before !== after) {
      problems.push(`${relPath}: directive lines went ${before} → ${after} — a directive is never a comment to delete`);
    }
  }

  if (problems.length > 0) {
    console.error(`✗ tidy/comments verify: ${problems.length} problem(s) against ${base}:`);
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.log(`✓ tidy/comments verify: ${files.length} changed source file(s) against ${base} are comment-only, and nothing else changed`);
}

const USAGE = `usage:
  npm run tidy -- inventory <path...> --out <file.jsonl>
  npm run tidy -- apply <decisions.jsonl> [--reapply]
  npm run tidy -- verify --base <git-ref>`;

function main(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "inventory") return cmdInventory(rest);
  if (subcommand === "apply") return cmdApply(rest);
  if (subcommand === "verify") return cmdVerify(rest);
  console.error(subcommand ? `✗ tidy/comments: unknown subcommand "${subcommand}"\n${USAGE}` : USAGE);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
