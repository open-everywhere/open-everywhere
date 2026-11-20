import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transformSync } from "esbuild";
import { init, parse } from "es-module-lexer";

await init;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(ROOT, "tests/integration/harness.ts");
const CORE_PREFIX = "@open-everywhere/core/";

const REFUSED = [join(ROOT, "packages/core/agent/adapter-api.ts")];

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function resolveSpecifier(from: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (spec.startsWith(CORE_PREFIX)) base = join(ROOT, "packages/core", spec.slice(CORE_PREFIX.length));
  else return undefined;
  const stem = base.replace(/\.(js|ts|mjs)$/, "");
  for (const candidate of [`${stem}.ts`, `${stem}.mts`, join(stem, "index.ts"), base]) {
    if (existsSync(candidate) && candidate.endsWith("ts")) return candidate;
  }
  return undefined;
}

function staticSpecifiers(source: string): string[] {
  const { code } = transformSync(source, {
    loader: "ts",
    format: "esm",
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  });
  const [imports] = parse(code);
  return imports.filter((i) => i.d === -1 && i.n !== undefined).map((i) => i.n!);
}

function followed(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith(CORE_PREFIX);
}

function walk(entry: string): Map<string, string[]> {
  const reached = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(file, spec);
      if (target === undefined) {
        ok(!followed(spec), `${relative(ROOT, file)} imports "${spec}", which resolves to no .ts source — the walk cannot follow it`);
        continue;
      }
      if (reached.has(target)) continue;
      reached.set(target, [...reached.get(file)!, target]);
      queue.push(target);
    }
  }
  return reached;
}

{
  const specs = staticSpecifiers(
    [
      `import { a } from "./a.js";`,
      `import type { B } from "./b.js";`,
      `export { c } from "./c.js";`,
      `export type { D } from "./d.js";`,
      `import {\n  e,\n  type F,\n} from "./e.js";`,
      `import "./side-effect.js";`,
      `/**\n * import { g } from "./in-a-comment.js";\n */`,
      `import {\n  h, // the fence's open tag; a quote and a semicolon\n} from "./comment-in-members.js";`,
      `export { X } from "./x.js"; export { Y } from "./y.js";`,
    ].join("\n"),
  );
  ok(specs.includes("./a.js"), "a value import is a static edge");
  ok(!specs.includes("./b.js"), "a wholly `import type` is erased, so it is not an edge");
  ok(specs.includes("./c.js"), "a value re-export is a static edge — the shape that caused OPE-2244's 2.2 s");
  ok(!specs.includes("./d.js"), "a wholly `export type` is erased, so it is not an edge");
  ok(specs.includes("./e.js"), "a multi-line import with an inline `type` member is still a value edge");
  ok(specs.includes("./side-effect.js"), "a bare side-effect import is a static edge");
  ok(!specs.includes("./in-a-comment.js"), "an import inside a doc comment is not an edge");
  ok(specs.includes("./comment-in-members.js"), "a member comment carrying a quote and a semicolon does not hide the edge");
  ok(specs.includes("./x.js") && specs.includes("./y.js"), "two statements on one line are two edges");
}

const reached = walk(HARNESS);
const rel = (p: string) => relative(ROOT, p);

ok(reached.has(join(ROOT, "agent/model/scripted-model.ts")), "the walk follows a relative import (agent/model/scripted-model.ts)");
ok(
  reached.has(join(ROOT, "packages/core/agent/access/untrusted.ts")),
  "the walk follows an @open-everywhere/core specifier (agent/access/untrusted.ts, the UNTRUSTED_* source)",
);

for (const barrel of REFUSED) {
  const chain = reached.get(barrel);
  ok(
    chain === undefined,
    `the integration harness reaches ${rel(barrel)} statically, which costs every integration file ~2 s of import ` +
      `(OPE-2244). Import the symbol from its defining module instead. Chain: ${(chain ?? []).map(rel).join(" → ")}`,
  );
}

function coreSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...coreSources(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const HOOK_SHAPES = [/^(?:void\s+)?install\w*Hook\([^)]*\);/m, /^[A-Za-z_$][\w$.]*\.__oe\w+\s*=(?![=>])/m];
const HOOK_EXEMPT = new Map<string, string>([]);
const scanned = coreSources(join(ROOT, "packages/core/agent"));
ok(scanned.length > 100 && scanned.includes(join(ROOT, "packages/core/agent/access/untrusted.ts")), `the hook scan walks the real core tree (${scanned.length} files, access/untrusted.ts among them)`);
const hookModules = scanned.filter((f) => {
  const src = readFileSync(f, "utf8");
  return HOOK_SHAPES.some((re) => re.test(src));
});
for (const exempt of HOOK_EXEMPT.keys()) {
  ok(hookModules.includes(exempt), `${rel(exempt)} is exempt but the scan no longer finds it — drop the stale exemption`);
}
// eve 1.x retired the last module that installs a globalThis hook at load (the 0.x tool-result
// projection, removed with the 0.x tool seam), so the real tree may hold none. The scan keeps its
// teeth through two controls: each hook shape matches a module that installs one, and neither
// matches a module that only reads a hook or compares against one.
ok(HOOK_SHAPES[0]!.test("installToolResultHook(projector);") && HOOK_SHAPES[1]!.test("globalThis.__oeToolResultProjection = project;"), "the scan's hook shapes match a module that installs a global hook");
ok(!HOOK_SHAPES.some((re) => re.test("const seen = globalThis.__oeToolResultProjection === project;\nif (x) installed = true;")), "the scan's hook shapes do NOT match a module that only reads or compares a hook");
const direct = new Set(
  staticSpecifiers(readFileSync(HARNESS, "utf8"))
    .map((s) => resolveSpecifier(HARNESS, s))
    .filter((p): p is string => p !== undefined),
);
for (const mod of hookModules) {
  if (HOOK_EXEMPT.has(mod)) continue;
  ok(
    direct.has(mod),
    `${rel(mod)} installs a globalThis hook at module load, but the integration harness does not import it directly. ` +
      `A test-side load after bootAgent() would overwrite the booted bundle's hook (OPE-2244). Add a side-effect import to the harness.`,
  );
}

console.log(`✓ harness-import-graph: ${passed} checks passed (${reached.size} modules in the harness's static graph)`);
