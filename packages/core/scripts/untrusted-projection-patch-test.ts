import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const src = readFileSync(join(eveRoot, "dist/src/harness/tool-loop.js"), "utf8");

ok(src.includes("OE UNTRUSTED OUTPUT PROJECTION (OPE-73)"), "patch present: the OPE-73 marker comment is in the installed bytes");
const helperDef = 'function __oeProjectToolSet(ts){const h=globalThis.__oeToolResultProjection;if(typeof h==="function")h(ts);return ts}';
ok(src.includes(helperDef), "patch present: the __oeProjectToolSet helper is byte-exact in the installed bytes");
const END = "// === END OE SPIKE HELPERS ===";
ok(src.indexOf(helperDef) < src.indexOf(END), "patch present: the helper lives inside the OE helper block (survives block-extraction by the sibling tests)");

const wiring = /__oeProjectToolSet\(([A-Za-z_$]{1,2})\);[A-Za-z_$]{1,2}\.outputSchema!==void 0&&\(\1\[FINAL_OUTPUT_TOOL_NAME\]=buildFinalOutputTool\(/;
ok(wiring.test(src), "wiring: __oeProjectToolSet(<toolset>) runs right before the final_output injection, on the same toolset variable");
ok((src.match(/__oeProjectToolSet\(/g) ?? []).length === 2, "wiring: exactly one call site (helper def + one invocation)");
const callIdx = src.search(wiring);
const mergeIdx = src.indexOf("buildDynamicTools(");
ok(mergeIdx !== -1 && mergeIdx < callIdx, "wiring: the dynamic-tool merge precedes the hook (dynamic tools are in the set it projects)");

const helper = new Function(`${helperDef}\n return __oeProjectToolSet;`)() as (ts: Record<string, unknown>) => Record<string, unknown>;

const HOOK_KEY = "__oeToolResultProjection";
const g = globalThis as Record<string, unknown>;
const saved = g[HOOK_KEY];

delete g[HOOK_KEY];
{
  const ts = { a: { execute: () => 1 } };
  const out = helper(ts);
  ok(out === ts, "drive: with no hook registered the toolset passes through (same object)");
  ok(Object.keys(ts.a).length === 1, "drive: with no hook registered nothing is mutated");
}

{
  let calls = 0;
  let seen: unknown;
  g[HOOK_KEY] = (ts: unknown) => {
    calls++;
    seen = ts;
  };
  const ts = { b: {} };
  const out = helper(ts);
  ok(calls === 1 && seen === ts, "drive: a registered hook is invoked exactly once with the toolset map");
  ok(out === ts, "drive: the same toolset object is returned (mutate-in-place contract)");
}

{
  g[HOOK_KEY] = () => {
    throw new Error("boom");
  };
  let threw = false;
  try {
    helper({});
  } catch {
    threw = true;
  }
  ok(threw, "drive: a throwing hook PROPAGATES — a broken projection fails the model call loudly, never runs unfenced");
}

{
  g[HOOK_KEY] = "not-a-function";
  const ts = { c: {} };
  ok(helper(ts) === ts, "drive: a non-function hook value is ignored (typeof gate)");
}

if (saved === undefined) delete g[HOOK_KEY];
else g[HOOK_KEY] = saved;

console.log(`\n✓ untrusted-projection-patch: ${n} assertions passed (presence, wiring shape, passthrough/invoke/throw/garbage drive)\n`);
