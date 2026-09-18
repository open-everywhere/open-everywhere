import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GLOSSARY = "docs/glossary.md";

const CITATION_FLOOR = 87;

export const CITATION = /`([A-Za-z0-9_./@-]*)#([A-Za-z0-9_$]+)`/g;

export const LINE_CITATION = /`([A-Za-z0-9_./@-]*\.(?:ts|tsx|js|mjs|cjs|json|md)):(\d+)(?:-\d+)?`/g;

export interface ParsedCitation {
  readonly path: string | undefined;
  readonly anchor: string;
  readonly whole: string;
  readonly index: number;
}

export function parseCitations(text: string): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  let lastPath: string | undefined;
  for (const match of text.matchAll(CITATION)) {
    const [whole, rawPath, anchor] = match;
    const path = rawPath === "" ? lastPath : rawPath;
    if (rawPath !== "") lastPath = rawPath;
    out.push({ path, anchor: anchor!, whole: whole!, index: match.index });
  }
  return out;
}

export function anchorLine(anchor: string): number | undefined {
  const match = /^L(\d+)$/.exec(anchor);
  return match ? Number(match[1]) : undefined;
}

function declarationPatterns(symbol: string): RegExp[] {
  const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (symbol === "default") return [/^export\s+default\b/];
  const KEYWORD = "(?:export\\s+|default\\s+|declare\\s+|abstract\\s+)";
  return [
    new RegExp(`^${KEYWORD}*(?:async\\s+)?(?:function|class|const|let|var|type|interface|enum)\\s+(?:enum\\s+)?${name}\\b`),
    new RegExp(`^(?:readonly\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|get\\s+|set\\s+)*${name}\\??\\s*[:<]`),
    new RegExp(`^(?:readonly\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|get\\s+|set\\s+)*${name}\\s*\\(.*(?:\\{|=>)\\s*$`),
    new RegExp(`^(?:readonly\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${name}\\??\\s*\\(.*\\)\\s*:`),
    new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b`),
    new RegExp(`^${name}\\s*,$`),
  ];
}

export function declarationLines(lines: readonly string[], symbol: string): number[] {
  const patterns = declarationPatterns(symbol);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (patterns.some((pattern) => pattern.test(text))) out.push(i + 1);
  }
  return out;
}

export function isExportedDeclaration(line: string, symbol: string): boolean {
  if (symbol === "default") return /^export\s+default\b/.test(line.trim());
  const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^export\\s+(?:default\\s+|declare\\s+|abstract\\s+|async\\s+)*(?:function|class|const|let|var|type|interface|enum)\\s+${name}\\b|^export\\s*\\{[^}]*\\b${name}\\b`).test(line.trim());
}

export const GLOSSARY_MARKER = /(?:\/\/|\*|#)\s*glossary:/;

const sourceCache = new Map<string, string[]>();
function sourceLines(path: string): string[] {
  let lines = sourceCache.get(path);
  if (lines === undefined) {
    lines = readFileSync(join(REPO, path), "utf8").split("\n");
    sourceCache.set(path, lines);
  }
  return lines;
}

export function citationProblem(
  citation: ParsedCitation,
  read: (path: string) => string[] | undefined,
): { problem?: string; exported?: boolean } {
  const { path, anchor } = citation;
  if (path === undefined) {
    return { problem: "a bare `#anchor` citation with no earlier path to continue from." };
  }
  const lines = read(path);
  if (lines === undefined) {
    return { problem: `cites ${path}, which does not exist. Cite what replaced it, or drop the claim.` };
  }

  const line = anchorLine(anchor);
  if (line !== undefined) {
    if (line < 1 || line > lines.length) {
      return { problem: `anchor #L${line} is outside ${path}, which has ${lines.length} lines.` };
    }
    const text = lines[line - 1]!;
    if (!GLOSSARY_MARKER.test(text)) {
      return {
        problem:
          `anchor #L${line} lands on ${JSON.stringify(text.trim().slice(0, 60))}, which carries no \`glossary:\` marker. ` +
          `An #L anchor is allowed ONLY for a non-declaration target that marks itself — add \`// glossary: <what>\` ` +
          `to that line, or cite a declared symbol instead.`,
      };
    }
    return {};
  }

  const declared = declarationLines(lines, anchor);
  if (declared.length === 0) {
    return { problem: `${path} declares no \`${anchor}\`. Find the symbol's real name and write it, or cite what replaced it.` };
  }
  return { exported: declared.some((n) => isExportedDeclaration(lines[n - 1]!, anchor)) };
}

function main(): void {
  const glossary = readFileSync(join(REPO, GLOSSARY), "utf8");
  const lineOfOffset = (offset: number): number => glossary.slice(0, offset).split("\n").length;

  const problems: string[] = [];
  let count = 0;
  let exported = 0;

  for (const match of glossary.matchAll(LINE_CITATION)) {
    problems.push(
      `${GLOSSARY}:${lineOfOffset(match.index)}  ${match[0]} — a FILE:LINE citation. Cite the symbol instead ` +
        `(\`${match[1]}#<symbol>\`): a line number is stale after any edit above the declaration, and one past change ` +
        `reddened main and every open pull request that way.`,
    );
  }

  const read = (path: string): string[] | undefined => (existsSync(join(REPO, path)) ? sourceLines(path) : undefined);
  for (const citation of parseCitations(glossary)) {
    count++;
    const { problem, exported: isExported } = citationProblem(citation, read);
    if (problem !== undefined) problems.push(`${GLOSSARY}:${lineOfOffset(citation.index)}  ${citation.whole} — ${problem}`);
    else if (isExported === true) exported++;
  }

  if (count < CITATION_FLOOR) {
    problems.push(
      `${GLOSSARY} carries ${count} citations, below the floor of ${CITATION_FLOOR}. Deleting citations is not a way ` +
        `to make this gate quiet: restore them, or lower CITATION_FLOOR deliberately and say why in the commit.`,
    );
  }
  if (exported === 0) {
    problems.push(
      "no citation resolved to an EXPORTED declaration. That is a broken pattern, not a clean file — the strong rule " +
        "just stopped checking anything a reader could import.",
    );
  }

  if (problems.length > 0) {
    console.error(`glossary citations: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  ✗ ${p}\n`);
    process.exit(1);
  }

  console.log(`glossary citations: ${count} checked (${exported} joined to an exported declaration), floor ${CITATION_FLOOR}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
