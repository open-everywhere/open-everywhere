import { existsSync, readdirSync, readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { disableTool } from "eve/tools";
import { readEveFrameworkTools } from "../packages/core/scripts/eve-framework-tools.js";

const SUBAGENT_ROOT = "agent/subagents/fresh_eyes_review";
const SUBAGENT_DIR = `${SUBAGENT_ROOT}/tools`;
const EVE_ROOT = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
const EVE_SRC = join(EVE_ROOT, "dist", "src");

const DISABLED_TOOL = Symbol.for("eve.disabled-tool");
function isDisabledToolSentinel(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, DISABLED_TOOL) === true;
}

let checks = 0;
function ok(condition: boolean, what: string): void {
  assert.ok(condition, what);
  checks += 1;
}

function eveSource(rel: string, why: string): string {
  const path = join(EVE_SRC, rel);
  ok(existsSync(path), `${path} exists — ${why}`);
  return readFileSync(path, "utf8");
}

ok(isDisabledToolSentinel(disableTool()), "negative control: eve's public disableTool() carries the `eve.disabled-tool` brand this test reads");
ok(!isDisabledToolSentinel({}) && !isDisabledToolSentinel(null), "negative control: a plain object or null is not a sentinel");
ok(
  /const DISABLED_TOOL=Symbol\.for\(`eve\.disabled-tool`\);function disableTool\(\)\{return\{\[DISABLED_TOOL\]:!0\}\}/u.test(
    eveSource("tools/definition.js", "it declares the sentinel brand that eve's compiler reads"),
  ),
  "eve still brands a sentinel with `Symbol.for(\"eve.disabled-tool\")` — the probe above reads that exact brand, because eve no longer exports `isDisabledToolSentinel` from `eve/tools`",
);

const eveTools = await readEveFrameworkTools();
const reserved = [...eveTools.reserved].sort();
ok(reserved.length > 0, `the reserved set is non-empty (read ${JSON.stringify(reserved)}) — an empty read would pass the reserved-slot clause by iterating nothing`);
ok(reserved.every((name) => name.startsWith("eve__")), `every reserved name is in eve's \`eve__\` namespace (read ${JSON.stringify(reserved)})`);
ok(
  /let a=eveNamespaceReservation\(i\);if\(a!==void 0\)throw Error\(`Tool "\$\{t\.logicalPath\}" uses the reserved name "\$\{i\}"\. Rename its path; \$\{a\}\.`\);if\(r\.kind===`disabled`\)/u.test(
    eveSource("compiler/normalize-tool.js", "it is where `eve build` refuses an authored module at a reserved name"),
  ),
  "eve's compiler throws on a reserved name BEFORE it reads a `disableTool()` sentinel — so an authored file can neither replace nor remove an `eve__` tool, and the subagent's containment for those names rests on the catalog conditions below",
);

const authored = readdirSync(SUBAGENT_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.slice(0, -".ts".length))
  .sort();
ok(authored.length > 0, `${SUBAGENT_DIR} authors at least one slot (read ${JSON.stringify(authored)}) — a zero-match read would pass the sentinel clauses vacuously`);
for (const name of reserved) {
  ok(!authored.includes(name), `${SUBAGENT_DIR}/${name}.ts does NOT exist — eve reserves "${name}" and \`eve build\` throws on any authored module there`);
}

const ALLOWED_IMPORTS = new Set(["eve/tools"]);
for (const slot of authored) {
  const file = `${SUBAGENT_DIR}/${slot}.ts`;
  const url = pathToFileURL(join(process.cwd(), file));
  const mod = (await import(url.href)) as { default: unknown };
  ok(
    isDisabledToolSentinel(mod.default),
    `${file} is a disableTool() sentinel — every slot this subagent authors must be one, because a hand-written tool at any slot is a hand`,
  );

  const source = readFileSync(url, "utf8");
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gmu)].map((m) => m[1]!);
  const sideEffectImports = [...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu)].map((m) => m[1]!);
  ok(specifiers.length > 0, `${file} parses as a module with imports — a zero-match read here would pass this check vacuously`);
  for (const spec of [...specifiers, ...sideEffectImports]) {
    ok(
      ALLOWED_IMPORTS.has(spec),
      `${file} imports "${spec}", which is not in the zero-hands allowlist [${[...ALLOWED_IMPORTS].join(", ")}]. An import here is a hand: this subagent must reach nothing.`,
    );
  }
  ok(sideEffectImports.length === 0, `${file} has no side-effect imports — one would arm behaviour this test never calls`);
  ok(!/\bfetch\s*\(|\bimport\s*\(|require\s*\(/u.test(source), `${file} performs no dynamic import, require or fetch`);
}

const catalog = eveSource("execution/catalog/catalog-tools.js", "it decides which `eve__` catalog routes a session holds");
ok(
  /function catalogReach\(e\)\{let t=\[\.\.\.e\.skills\.values\(\)\];let n=e\.connections\.length>0;return\{connections:n,searchableSkills:t\.some\(e=>e\.deferred\),skills:t\.length>0,tools:n\|\|e\.deferred\.size>0\}/u.test(catalog) &&
    /let r=t\.tools\|\|t\.searchableSkills;let i=new Set\(\[\.\.\.r\?\[SEARCH_TOOL_NAME\]:\[\],\.\.\.t\.tools\?\[CALL_TOOL_NAME\]:\[\],\.\.\.t\.skills\?\[SKILL_TOOL_NAME\]:\[\]\]\)/u.test(catalog),
  "eve mounts `eve__skill` only while the catalog holds a skill, and `eve__search` / `eve__tool` only while it holds a connection, a deferred tool or a deferred skill. These conditions replace the old skill-loader sentinel: no authored file can remove a reserved route, so the subagent holds none of them only while it declares none of their inputs",
);

for (const dir of ["skills", "connections"]) {
  ok(
    !existsSync(join(process.cwd(), SUBAGENT_ROOT, dir)),
    `${SUBAGENT_ROOT}/${dir}/ does not exist — this subagent declares no ${dir}, which is the condition the catalog clause above rests on. Adding one mounts an \`eve__\` catalog route into a pass that is supposed to reach nothing.`,
  );
}

const mounted = eveTools.defaultMounted.filter((name) => !reserved.includes(name)).sort();
ok(mounted.length > 0, `the reader names at least one default-mounted tool (read ${JSON.stringify(mounted)}) — a zero-match read would pass this clause by iterating nothing`);
ok(mounted.includes("edit_file"), `eve mounts \`edit_file\` by default (read ${JSON.stringify(mounted)}) — the slot the sentinel set must now cover`);
for (const name of mounted) {
  ok(
    authored.includes(name),
    `${SUBAGENT_DIR}/${name}.ts EXISTS — eve mounts "tools/${name}" on every local node, and an ABSENT file does not mean "no tool": it falls back to eve's framework default, unfenced, with none of the root's hooks behind it. Add the \`disableTool()\` sentinel.`,
  );
}

ok(
  existsSync(join(process.cwd(), SUBAGENT_ROOT, "hooks", "spend.ts")),
  `${SUBAGENT_ROOT}/hooks/spend.ts exists — hooks are NOT inherited from the root, so without it this subagent's model calls reach neither the usage_events ledger nor the monthly cap, and nothing else in the tree would notice`,
);
ok(
  existsSync(join(process.cwd(), SUBAGENT_ROOT, "instructions.md")),
  `${SUBAGENT_ROOT}/instructions.md exists — a subagent inherits NO instructions (eve's isolation boundary), so without its own file it runs on the framework default prompt instead of the review brief`,
);

console.log(
  `✓ subagent-zero-hands: ${checks} assertions passed — eve reserves ${JSON.stringify(reserved)}, ${SUBAGENT_DIR} authors none of them, ` +
    `its ${authored.length} authored slot(s) are closed sentinels, a sentinel exists for every tool eve mounts by default, ` +
    `the subagent declares no skills and no connections (so it holds no \`eve__\` catalog route), ` +
    `and its spend hook and instructions file are present.`,
);

// proves: ROSTER-lint-subagents
