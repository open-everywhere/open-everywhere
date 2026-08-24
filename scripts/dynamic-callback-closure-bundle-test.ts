import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BUNDLE_PATH = join(ROOT, ".output", "server", "index.mjs");

interface DeclaredCapture {
  readonly fn: string;
  readonly captures: readonly string[];
  readonly why: string;
}

const DECLARED_CAPTURES: readonly DeclaredCapture[] = [
  {
    captures: ["grant"],
    fn: "grantToolEntry",
    why:
      "OPE-1060 credential grants. Every grant entry mounts through registerDynamicVariant, whose " +
      "installVariants fills the durable descriptors with `overwrite: true` and its own `{ entryKey }` " +
      "closure. The transform's stamp is replaced at registration and eve never parses this capture — " +
      "rule (b) above. If this name ever moves to preRegisterDynamicEntry, this declaration is wrong.",
  },
];

if (process.env.VERCEL) {
  console.log("dynamic-callback-closure-bundle: SKIP — Vercel builder shape writes no .output/ (OPE-1055).");
  process.exit(0);
}

if (!existsSync(BUNDLE_PATH)) {
  console.error(
    `✗ dynamic-callback-closure-bundle: ${BUNDLE_PATH} does not exist. This script reads BUILD OUTPUT — ` +
      "run `npm run build` first (which already chains this script).",
  );
  process.exit(1);
}

const bundle = readFileSync(BUNDLE_PATH, "utf8");

function matchingClose(source: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closer = pairs[source[open]];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === source[open]) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

function enclosingFunctionName(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const matches = [...before.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/gu)];
  const last = matches[matches.length - 1];
  return last === undefined ? "<unknown>" : last[1];
}

interface StampSite {
  readonly fn: string;
  readonly line: number;
  readonly closure: string;
}

const sites: StampSite[] = [];
const callRe = /__eveStampDynamicCallback(?:\$\d+)?\s*\(/gu;
let match: RegExpExecArray | null;
while ((match = callRe.exec(bundle)) !== null) {
  if (/function\s+$/u.test(bundle.slice(Math.max(0, match.index - 12), match.index))) continue;
  const open = match.index + match[0].length - 1;
  const close = matchingClose(bundle, open);
  if (close === -1) {
    console.error(`✗ dynamic-callback-closure-bundle: unbalanced parentheses at offset ${open} — cannot parse the bundle.`);
    process.exit(1);
  }
  const args = topLevelArgs(bundle.slice(open + 1, close));
  const closure = (args[args.length - 1] ?? "").trim();
  sites.push({
    closure: closure.replace(/\s+/gu, " "),
    fn: enclosingFunctionName(bundle, match.index),
    line: bundle.slice(0, match.index).split("\n").length,
  });
}

const problems: string[] = [];

const MINIMUM_EXPECTED_SITES = 50;
if (sites.length < MINIMUM_EXPECTED_SITES) {
  problems.push(
    `only ${sites.length} \`__eveStampDynamicCallback\` call site(s) in the bundle, expected at least ` +
      `${MINIMUM_EXPECTED_SITES}. eve's build transform did not run, or its emitted shape changed. This gate ` +
      "reads that shape, so it is now blind — fix the reader before trusting a green.",
  );
}

const claimed = new Set<DeclaredCapture>();
for (const site of sites) {
  if (site.closure === "{}") continue;
  const captures = site.closure
    .replace(/^\{|\}$/gu, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const declared = DECLARED_CAPTURES.find((d) => d.fn === site.fn && d.captures.join(",") === captures.join(","));
  if (declared !== undefined) {
    claimed.add(declared);
    continue;
  }
  problems.push(
    `${BUNDLE_PATH}:${site.line} — \`${site.fn}\` stamps a durable dynamic-tool callback whose closure is ` +
      `\`${site.closure}\`, which is not declared. eve PERSISTS this object and JSON-parses it at resolve ` +
      "time; a value that does not serialize throws, and eve then drops the WHOLE resolver's result — every " +
      "tool it returns vanishes from the seat with no red anywhere (OPE-1063). Either hoist the callback out " +
      "of the `defineTool({ … })` literal into a module-level factory called as `execute: makeExecute(…)` " +
      "(the transform never stamps a CALL expression, so `preRegisterDynamicEntry` fills the descriptor with " +
      "an empty closure), or add a DECLARED_CAPTURES entry in this script saying why the capture is safe.",
  );
}

for (const declared of DECLARED_CAPTURES) {
  if (claimed.has(declared)) continue;
  problems.push(
    `DECLARED_CAPTURES names \`${declared.fn}\` capturing \`{ ${declared.captures.join(", ")} }\`, but the bundle ` +
      "has no such call site. The code moved or the capture changed — re-read it and update or delete the " +
      "declaration rather than leaving a stale exemption that would cover a future capture.",
  );
}

if (problems.length > 0) {
  console.error(`✗ dynamic-callback-closure-bundle: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}\n`);
  process.exit(1);
}

console.log(
  `✓ dynamic-callback-closure-bundle: ${sites.length} stamped dynamic-tool callback(s) in the build output, ` +
    `${sites.length - claimed.size} with an empty closure and ${claimed.size} declared.`,
);
