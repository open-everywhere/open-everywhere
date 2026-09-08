import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BARREL = join(here, "..", "agent", "adapter-api.ts");
const PIN = join(here, "adapter-api-surface.json");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function blankComments(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/gu, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/\/\*[\s\S]*$/u, blank)
    .replace(/\/\/[^\n]*/gu, blank);
}

function exportedNames(source: string): readonly string[] {
  const names = new Set<string>();
  const lines = blankComments(source).split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!/^\s*export\b/u.test(line)) continue;
    seen++;
    const head = /^\s*export\s+(?:type\s+)?\{/u.exec(line);
    if (head === null) {
      throw new Error(`adapter-api.ts line ${i + 1} is not a named re-export — this scan reads no other export shape: ${line.trim()}`);
    }
    let body = line.slice(head[0].length);
    let end = body.indexOf("}");
    for (let j = i + 1; end < 0 && j < lines.length; j++) {
      body += `\n${lines[j] as string}`;
      end = body.indexOf("}");
      i = j;
    }
    if (end < 0) throw new Error(`adapter-api.ts line ${i + 1}: the export clause is never terminated`);
    if (/\bexport\b/u.test(body.slice(end))) {
      throw new Error(`adapter-api.ts line ${i + 1} carries more than one export statement — this scan reads one clause per line`);
    }
    for (const raw of body.slice(0, end).split(",")) {
      const spec = raw.trim().replace(/^type\s+/u, "");
      if (spec === "") continue;
      const parts = spec.split(/\s+as\s+/u);
      const published = (parts[parts.length - 1] as string).trim();
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(published)) {
        throw new Error(`adapter-api.ts: \`${published}\` does not read as an exported identifier`);
      }
      names.add(published);
    }
  }
  if (seen <= 100) throw new Error(`the scan found only ${seen} export lines in adapter-api.ts — it is not reading the file`);
  return [...names].sort();
}

const pad = Array.from({ length: 101 }, (_, n) => `export { pad${n} } from "./p.js";`).join("\n");

function scanRefused(fixture: string): boolean {
  try {
    exportedNames(fixture);
    return false;
  } catch {
    return true;
  }
}

ok(exportedNames(`${pad}\nexport { alpha, type Beta as Gamma } from "./x.js";`).includes("Gamma"), "the scan reads `a as b` and publishes `b`");
ok(exportedNames(`${pad}\nexport type { Delta } from "./x.js";`).includes("Delta"), "…and reads a `export type {…}` clause");

ok(exportedNames(`${pad}\n  export { indented } from "./x.js";`).includes("indented"), "🔴 an INDENTED export line is read, not skipped");

{
  const names = exportedNames(`${pad}\nexport {\n  before,\n  // a Record<string, {v}> of them\n  after,\n} from "./x.js";`);
  ok(names.includes("before"), "a clause carrying a `}` in a comment still yields the specifier before it");
  ok(names.includes("after"), "🔴 …AND the one after it — the comment does not close the clause");
  ok(!names.some((n) => n.startsWith("a")===true && n.includes("Record")), "…and the note itself never becomes a name");
}

ok(!exportedNames(`${pad}\n// export { ghost } from "./x.js";`).includes("ghost"), "a commented-out export line contributes no name");

ok(scanRefused(`${pad}\nexport * from "./x.js";`), "🔴 `export *` is refused — its set cannot be enumerated from this source");
ok(scanRefused(`${pad}\nexport const declared = 1;`), "🔴 a direct declaration is refused — the barrel is re-exports only");
ok(scanRefused(`${pad}\nexport function fn(): void {}`), "🔴 …a function declaration too");
ok(scanRefused(`${pad}\nexport {\n  unterminated,\nfrom "./x.js";`), "🔴 an unterminated clause is refused, never read as far as it got");
ok(
  scanRefused(`${pad}\nexport { first } from "./x.js"; export { second } from "./y.js";`),
  "🔴 two export statements on one line are refused — the second's names must never be silently dropped",
);
ok(exportedNames(`${pad}\nexport { solo } from "./exporter.js";`).includes("solo"), "…while a single statement whose path mentions `export` still reads");
ok(scanRefused('export { onlyOne } from "./x.js";'), "🔴 a source with too few export lines is refused — the scan is not reading the file");

ok(!scanRefused(`${pad}\nexport { fine } from "./x.js";`), "🔴 `scanRefused` answers false for a readable fixture — the refusals above are real");

const actual = exportedNames(readFileSync(BARREL, "utf8"));
const pinned = JSON.parse(readFileSync(PIN, "utf8")) as { readonly exports: readonly string[] };

ok(Array.isArray(pinned.exports), "the pin file carries an `exports` array");
ok(pinned.exports.length > 100, `the pin is not empty (${pinned.exports.length} names)`);
ok(actual.length > 100, `the scan really parsed the barrel (${actual.length} exported names)`);
ok(actual.includes("stampModelCall"), "🔴 the scan sees a known value export (`stampModelCall`)");
ok(actual.includes("BindableContext"), "🔴 …and a known TYPE export (`BindableContext`), which `dist` would have erased");
ok(!actual.includes("connectorOpTierFromCompletion"), "…and does not see a name the barrel no longer exports (OPE-1476)");

const added = actual.filter((n) => !pinned.exports.includes(n));
const removed = pinned.exports.filter((n) => !actual.includes(n));

ok(
  removed.length === 0,
  `🔴 adapter-api.ts NO LONGER EXPORTS [${removed.join(", ")}] — this is a BREAKING CHANGE for a consumer of ` +
    `@open-everywhere/core/agent/adapter-api.js. If the withdrawal is intended, delete those names from ` +
    "packages/core/scripts/adapter-api-surface.json in the same commit and say so in the commit message.",
);
ok(
  added.length === 0,
  `adapter-api.ts now exports [${added.join(", ")}] — a new name on a published surface. If that is intended, add it ` +
    "to packages/core/scripts/adapter-api-surface.json in the same commit.",
);

ok(new Set(pinned.exports).size === pinned.exports.length, "the pin lists every name once");

console.log(`✓ adapter-api-surface: ${passed} assertions passed (${actual.length} published names pinned)`);
