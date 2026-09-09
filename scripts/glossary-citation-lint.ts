import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GLOSSARY = "docs/glossary.md";

const CITATION_FLOOR = 80;

const CITATION = /`([A-Za-z0-9_./@-]*):(\d+)(?:-(\d+))?`(?:\s*\(\s*`([^`]+)`\s*\))?/g;

const BARE_DELIMITERS = new Set(["{", "}", "(", ")", "[", "]", "};", "},", "];", "*", "*/", "/**", "/*"]);
function isStructural(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || BARE_DELIMITERS.has(trimmed) || /^import\s/.test(trimmed) || /^export\s*\{/.test(trimmed);
}

const sourceCache = new Map<string, string[]>();
function sourceLines(path: string): string[] {
  let lines = sourceCache.get(path);
  if (lines === undefined) {
    lines = readFileSync(join(REPO, path), "utf8").split("\n");
    sourceCache.set(path, lines);
  }
  return lines;
}

const glossary = readFileSync(join(REPO, GLOSSARY), "utf8");
const glossaryLines = glossary.split("\n");
const lineOfOffset = (offset: number): number => glossary.slice(0, offset).split("\n").length;

const problems: string[] = [];
let count = 0;
let withSymbol = 0;
let lastPath: string | undefined;

for (const match of glossary.matchAll(CITATION)) {
  const [whole, rawPath, startText, , symbolText] = match;
  const path = rawPath === "" ? lastPath : rawPath;
  if (rawPath !== "") lastPath = rawPath;
  count++;
  const where = `${GLOSSARY}:${lineOfOffset(match.index)}  ${whole}`;

  if (path === undefined) {
    problems.push(`${where} — a bare \`:line\` citation with no earlier path to continue from.`);
    continue;
  }
  if (!existsSync(join(REPO, path))) {
    problems.push(`${where} — cites ${path}, which does not exist. Cite what replaced it, or drop the claim.`);
    continue;
  }
  const lines = sourceLines(path);
  const start = Number(startText);
  if (start < 1 || start > lines.length) {
    problems.push(`${where} — line ${start} is outside ${path}, which has ${lines.length} lines.`);
    continue;
  }
  const text = lines[start - 1]!;
  const symbol = symbolText?.replace(/`/g, "").trim();

  if (symbol !== undefined && symbol !== "") {
    withSymbol++;
    if (!text.includes(symbol)) {
      problems.push(`${where} — ${path}:${start} does not carry \`${symbol}\`. The line reads: ${text.trim().slice(0, 100)}`);
    }
  } else if (isStructural(text)) {
    problems.push(
      `${where} — ${path}:${start} lands on ${JSON.stringify(text.trim().slice(0, 60))}, which carries no claim. ` +
        `The line moved; find the one this entry meant and cite it, with a \`symbol\` where one exists.`,
    );
  }
}

if (count < CITATION_FLOOR) {
  problems.push(
    `${GLOSSARY} carries ${count} citations, below the floor of ${CITATION_FLOOR}. Deleting citations is not a way ` +
      `to make this gate quiet: restore them, or lower CITATION_FLOOR deliberately and say why in the commit.`,
  );
}
if (withSymbol === 0) {
  problems.push(
    "no citation named a symbol at all. That is a broken pattern, not a clean file — rule ② is the strong one " +
      "and it just stopped checking anything.",
  );
}

if (problems.length > 0) {
  console.error(`glossary citations: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`glossary citations: ${count} checked (${withSymbol} joined to a named symbol), floor ${CITATION_FLOOR}.`);
