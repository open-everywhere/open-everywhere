import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BUNDLE_DIR = join(ROOT, ".output", "server");
const STAMP = "__eveStampDynamicCallback";

function findStampedBundles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;
    const path = join(dir, entry);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes(`${STAMP}(`)) found.push(path);
  }
  return found.sort();
}

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

if (!existsSync(BUNDLE_DIR)) {
  console.error(
    `✗ dynamic-callback-closure-bundle: ${BUNDLE_DIR} does not exist. This script reads BUILD OUTPUT — ` +
      "run `npm run build` first (which already chains this script).",
  );
  process.exit(1);
}

const stampedBundles = findStampedBundles(BUNDLE_DIR);
if (stampedBundles.length !== 1) {
  console.error(
    `✗ dynamic-callback-closure-bundle: expected exactly ONE build-output module containing \`${STAMP}(\`, ` +
      `found ${stampedBundles.length}${stampedBundles.length === 0 ? "" : ` (${stampedBundles.join(", ")})`} under ` +
      `${BUNDLE_DIR}. Zero means eve's build transform did not run or its emitted shape changed; more than one ` +
      `means the stamped code was split across chunks and reading one would leave the others unchecked. Read the ` +
      `output and re-derive this resolver; do not widen it.`,
  );
  process.exit(1);
}
const BUNDLE_PATH = stampedBundles[0] as string;

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

function skipQuoted(source: string, i: number): number {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") j++;
    else if (source[j] === quote) return j;
  }
  return -1;
}

function matchingCloseOutsideStrings(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(source, i);
      if (i === -1) return -1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevelMembers(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipQuoted(body, i);
      if (end === -1) break;
      i = end;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(body.slice(start).trim());
  return out.filter((m) => m.length > 0);
}

function bracedBodyAfter(source: string, from: number): string | undefined {
  const open = source.indexOf("{", from);
  if (open === -1) return undefined;
  const close = matchingCloseOutsideStrings(source, open);
  return close === -1 ? undefined : source.slice(open + 1, close);
}

const escapeRe = (s: string): string => s.replace(/[$.*+?^()[\]{}|\\]/gu, "\\$&");

function defineToolMembers(source: string, binding: string): string[] | undefined {
  const m = new RegExp(`(?:var|let|const)\\s+${escapeRe(binding)}\\s*=\\s*defineTool(?:\\$\\d+)?\\(\\s*\\{`, "u").exec(source);
  if (m === null) return undefined;
  const body = bracedBodyAfter(source, m.index + m[0].length - 1);
  return body === undefined ? undefined : topLevelMembers(body);
}

function importedDurableSchemaNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const clause of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:eve(?:\/[^"']*)?|(?:\.\.?\/)+(?:[^"']*\/)?_libs\/eve\.mjs)["']/gu)) {
    for (const spec of (clause[1] as string).split(",")) {
      const [imported, local] = spec.trim().split(/\s+as\s+/u);
      if (imported === "defineDurableSchema") names.add((local ?? imported).trim());
    }
  }
  return names;
}

function durableSchemaProblem(value: string, durableNames: ReadonlySet<string>): string | undefined {
  const call = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*\{/u.exec(value);
  if (call === null || !durableNames.has(call[1] as string)) {
    return `is \`${value.slice(0, 80).replace(/\s+/gu, " ")}…\`, not a \`defineDurableSchema(…)\` call imported from eve`;
  }
  const body = bracedBodyAfter(value, call[0].length - 1);
  const closure = body === undefined ? undefined : topLevelMembers(body).find((m) => /^closure\s*:/u.test(m));
  const closureValue = closure?.replace(/^closure\s*:/u, "").replace(/\s+/gu, "");
  return closureValue === "{}" ? undefined : `carries closure \`${closureValue ?? "<none>"}\`, not \`{}\``;
}

const browserFacts: string[] = [];
{
  const durableNames = importedDurableSchemaNames(bundle);
  const vendor = (await import("@agent-browser/eve/tools")) as Record<string, unknown>;
  const vendorNames = Object.entries(vendor)
    .filter(([, t]) => {
      const tool = t as { execute?: unknown; description?: unknown } | undefined;
      return typeof tool?.execute === "function" && typeof tool.description === "string";
    })
    .map(([name]) => name)
    .sort();

  const adapterAt = bundle.search(/function\s+registerAgentBrowser\s*\(/u);
  const adapterBody = adapterAt === -1 ? undefined : bracedBodyAfter(bundle, bundle.indexOf(")", adapterAt));
  const nsName = adapterBody === undefined ? undefined : /Object\.entries\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/u.exec(adapterBody)?.[1];
  const nsAt = nsName === undefined ? null : new RegExp(`(?:var|let|const)\\s+${escapeRe(nsName)}\\s*=\\s*__exportAll(?:\\$\\d+)?\\(\\s*\\{`, "u").exec(bundle);
  const nsBody = nsAt === null ? undefined : bracedBodyAfter(bundle, nsAt.index + nsAt[0].length - 1);

  if (durableNames.size === 0) {
    problems.push(`${BUNDLE_PATH} imports no \`defineDurableSchema\` from eve. The build transform's schema stamp changed shape — re-derive this section before trusting a green.`);
  } else if (nsBody === undefined) {
    problems.push(
      `${BUNDLE_PATH} holds no bundled vendor namespace for \`registerAgentBrowser\` (found adapter=${adapterAt !== -1}, namespace=${nsName ?? "<none>"}). ` +
        "If `@agent-browser/eve` is no longer bundled, eve's build transform no longer stamps its schemas and eve 0.71 drops the whole browser kit (OPE-2330).",
    );
  } else {
    const bindings = new Map<string, string>();
    for (const member of topLevelMembers(nsBody)) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\(\)\s*=>\s*([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(member);
      if (m !== null) bindings.set(m[1] as string, m[2] as string);
    }
    const bundledNames = [...bindings.keys()].sort();
    if (vendorNames.length === 0 || bundledNames.join(",") !== vendorNames.join(",")) {
      problems.push(
        `the bundled vendor namespace \`${nsName}\` exports [${bundledNames.join(", ")}], but the installed ` +
          `\`@agent-browser/eve/tools\` exports [${vendorNames.join(", ")}]. The two must match, or a mounted tool goes unchecked.`,
      );
    }
    let described = 0;
    let examined = 0;
    for (const [name, binding] of bindings) {
      const members = defineToolMembers(bundle, binding);
      if (members === undefined) {
        problems.push(`vendor browser tool \`${name}\` (\`${binding}\`) is not a \`defineTool({ … })\` literal in ${BUNDLE_PATH}, so its schema descriptor cannot be read.`);
        continue;
      }
      for (const key of ["inputSchema", "outputSchema"] as const) {
        const member = members.find((m) => new RegExp(`^${key}\\s*:`, "u").test(m));
        if (member === undefined) continue;
        examined++;
        const why = durableSchemaProblem(member.replace(new RegExp(`^${key}\\s*:\\s*`, "u"), ""), durableNames);
        if (why === undefined) {
          described++;
          continue;
        }
        problems.push(
          `vendor browser tool \`browser_${name}\`'s \`${key}\` ${why}. eve 0.71 refuses a validator schema with no durable ` +
            "descriptor and drops the WHOLE `browser_tools` resolver, so every browser tool vanishes from the seat (OPE-2330). " +
            "Give the vendor schemas a descriptor in `registerBrowserToolkit` itself, with eve's `defineDurableSchema` as `withDurableSchemas` does in access/window-gated.ts, rather than rely on the transform. Then invert §2 of packages/core/scripts/browser-toolkit-durable-schema-test.ts.",
        );
      }
    }
    if (examined < vendorNames.length) {
      problems.push(`only ${examined} vendor schema(s) found for ${vendorNames.length} vendor browser tool(s). Each vendor tool authors an \`inputSchema\`, so the reader is blind — re-derive it.`);
    }
    browserFacts.push(`${bindings.size} vendor browser tool(s), ${described} described schema(s)`);
  }

  const kitAt = bundle.search(/function\s+registerBrowserToolkit\s*\(/u);
  const kitBody = kitAt === -1 ? undefined : bracedBodyAfter(bundle, bundle.indexOf(")", kitAt));
  const literalAt = kitBody?.search(/defineTool(?:\$\d+)?\(\s*\{/u) ?? -1;
  const wrapper = kitBody === undefined || literalAt === -1 ? undefined : bracedBodyAfter(kitBody, literalAt);
  if (wrapper === undefined) {
    problems.push(`${BUNDLE_PATH} holds no \`registerBrowserToolkit\` with a \`defineTool({ … })\` literal — re-derive this section.`);
  } else {
    const members = topLevelMembers(wrapper);
    const spreadsEntry = members.some((m) => /^\.\.\.(?:withDurableSchemas(?:\$\d+)?\(\s*)?entry\)?$/u.test(m));
    const ownSchemaKeys = [...wrapper.matchAll(/\b(?:inputSchema|outputSchema)\b[^,\n]{0,40}/gu)].map((m) => m[0]);
    if (!spreadsEntry || ownSchemaKeys.length > 0) {
      problems.push(
        "`registerBrowserToolkit`'s `defineTool` literal must spread the vendor entry (`...entry` or `...withDurableSchemas(entry)`) " +
          `and set no schema key itself (spread=${spreadsEntry}, own schema keys=[${ownSchemaKeys.join(" | ")}]). ` +
          "Its schemas are the vendor's described ones only through that spread (OPE-2330).",
      );
    } else browserFacts.push("the toolkit wrapper spreads them unchanged");
  }
}

if (problems.length > 0) {
  console.error(`✗ dynamic-callback-closure-bundle: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}\n`);
  process.exit(1);
}

console.log(
  `✓ dynamic-callback-closure-bundle: ${sites.length} stamped dynamic-tool callback(s) in the build output, ` +
    `${sites.length - claimed.size} with an empty closure and ${claimed.size} declared; ${browserFacts.join(", ")}.`,
);
