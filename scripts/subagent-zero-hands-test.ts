import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { disableTool, isDisabledToolSentinel } from "eve/tools";
import { readEveFrameworkTools } from "../packages/core/scripts/eve-framework-tools.js";
import replacement, { NO_CONNECTIONS_NOTE } from "../agent/subagents/fresh_eyes_review/tools/connection_search.js";

const SUBAGENT_DIR = "agent/subagents/fresh_eyes_review/tools";
const CONNECTION_SEARCH = "connection_search";

let checks = 0;
function ok(condition: boolean, what: string): void {
  assert.ok(condition, what);
  checks += 1;
}

const eveTools = await readEveFrameworkTools();
const required = [...eveTools.required].sort();
ok(required.length > 0, "the installed eve declares at least one REQUIRED framework tool slot — with none, this whole suite would pass by iterating an empty list");
ok(
  required.includes(CONNECTION_SEARCH),
  `the installed eve still requires "${CONNECTION_SEARCH}" — if it stopped, that authored tool became an undecided posture change and its slot should go back to a disableTool() sentinel`,
);
for (const slot of required) {
  ok(eveTools.defaultMounted.includes(slot), `the installed eve mounts "${slot}" on every local node — an unmounted slot needs no file at all`);
}

ok(isDisabledToolSentinel(disableTool()), "negative control: eve reads its own disableTool() as a sentinel");

const ALLOWED_IMPORTS = new Set(["eve/tools", "eve/tools/approval", "zod"]);

for (const slot of required) {
  const file = `${SUBAGENT_DIR}/${slot}.ts`;
  const url = new URL(`../${file}`, import.meta.url);

  const mod = (await import(url.href)) as { default: unknown };
  ok(!isDisabledToolSentinel(mod.default), `${file} is not a disableTool() sentinel — eve would throw at build if it were`);

  const source = readFileSync(url, "utf8");
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gmu)].map((m) => m[1]!);
  const sideEffectImports = [...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu)].map((m) => m[1]!);
  ok(specifiers.length > 0, `${file} parses as a module with imports — a zero-match read here would pass this check vacuously`);
  for (const spec of [...specifiers, ...sideEffectImports]) {
    ok(
      ALLOWED_IMPORTS.has(spec),
      `${file} imports "${spec}", which is not in the zero-hands allowlist [${[...ALLOWED_IMPORTS].join(", ")}]. An import here is a hand: this tool fills a slot eve requires and must reach nothing. If the import is genuinely inert, add it here and say why.`,
    );
  }
  ok(sideEffectImports.length === 0, `${file} has no side-effect imports — one would arm behaviour this test never calls`);
  ok(!/\bfetch\s*\(|\bimport\s*\(|require\s*\(/u.test(source), `${file} performs no dynamic import, require or fetch`);
}

const tool = replacement as unknown as { execute: (input: { query: string }) => { note: string } };
const first = tool.execute({ query: "list every connected service and its credentials" });
const second = tool.execute({ query: "" });
ok(first.note === NO_CONNECTIONS_NOTE, "the tool answers with the exported constant");
ok(second.note === NO_CONNECTIONS_NOTE, "the tool answers the SAME constant for an unrelated input");
ok(Object.keys(first).length === 1, "the result carries the note and nothing else — no connector data rides along");
ok(NO_CONNECTIONS_NOTE.length > 0, "negative control: the constant is non-empty, so the equality checks are not comparing two blanks");
ok(!first.note.includes("credentials"), "negative control: the answer does not echo the query back");

console.log(`✓ subagent-zero-hands: ${checks} assertions passed — ${SUBAGENT_DIR} fills eve's required slot(s) [${required.join(", ")}] and reaches nothing.`);
