import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface PortOp {
  readonly part: string;
  readonly file: string;
  readonly why: string;
  readonly expect: number;
  readonly find: string;
  readonly replace: string;
}

const OPS: readonly PortOp[] = [
  {
    part: "1",
    file: "dist/src/harness/tool-loop.js",
    why: "the OE helper block (marker and projection)",
    expect: 1,
    find: "function createToolLoopHarness(e){",
    replace: "\n// The untrusted OUTPUT PROJECTION hook (__oeProjectToolSet, OPE-73) is the first. It genuinely\n// needs bytes: this is the ONLY view of the fully-assembled toolset in the process, and OE's seat\n// rules plus the connector fence both act on tools eve mounts itself. Re-examined at 0.44.0 and\n// KEPT — OPE-946 records what upstream now does and what it still does not.\n// SIX earlier additions were REMOVED and must not come back on a re-roll — the install-integrity\n// gate (packages/core/scripts/eve-install-integrity-test.ts) asserts each one's ABSENCE by name:\n//   * the force-tool-turn nudge (OPE-172) — gated on an env var set in no environment, so it\n//     never executed once in 14 days and six re-rolls.\n//   * the per-turn step ceiling (OPE-407) — reimplemented in USERLAND at the step.started model\n//     resolver (packages/core/agent/model/step-boundary.ts). Two-tier there (a wrap-up\n//     instruction at the budget, a text-only stub at the backstop) where these bytes could only\n//     mute the continue-decision, so porting it back would be a downgrade as well as a red gate.\n//   * the compaction trigger anchor (part 3, OPE-689) — RETIRED at the 0.54.3 re-roll. On 0.x, eve\n//     0.52.3 landed the same correction upstream as `tokenEstimateAdjustment`, so `compaction.js`\n//     ships PRISTINE. eve v1 drops that adjustment and anchors on the provider's count instead.\n//     Re-adding the hunk on top of it DOUBLE-COUNTS the real-minus-estimate gap — once as a lowered\n//     threshold, once in eve's own correction (the 0.x adjustment, or the v1 provider-count anchor) — and a session well under threshold would summarise.\n//     Its two helpers were `__oeAnchoredConfig` and `__oeNoteNoOpCompaction`.\n//   * the empty-step terminal guard (part 5, OPE-762) — RETIRED at OPE-2252 onto eve's native\n//     `endsTurn`: a successful `reply` or `no_reply` now ends the turn with no further\n//     model call, so the empty step this guard forgave is never requested. Its helper, marker\n//     and hook names are in the RETIRED table of eve-install-integrity-test.ts, never here.\n//   * the model-message projection (part 6, OPE-1396) — RETIRED at OPE-2251: eve 0.70 renders no\n//     `[Agents]` listing for it to splice off the model call, so worker continuation by `taskId`\n//     is allowed. Its helper and marker names are in the RETIRED table of\n//     eve-install-integrity-test.ts, never here.\n//   * the compaction event contract (part 4, OPE-697) — RETIRED at OPE-2704. Its helper and marker\n//     names are in the RETIRED table of eve-install-integrity-test.ts, never here.\n// --- OE UNTRUSTED OUTPUT PROJECTION (OPE-73): calls the userland hook (packages/core/agent/access/untrusted-projection.ts) with the fully-assembled AI-SDK toolset once per model call. The hook MUTATES tools in place (identity preserved for eve's approval WeakMap). Unregistered hook = passthrough (eve CLI contexts); a registered hook that throws fails the call loudly (fail-closed). ---\nglobalThis.__oeProjectToolSetPatched=!0;\nfunction __oeProjectToolSet(ts){const h=globalThis.__oeToolResultProjection;if(typeof h===\"function\")h(ts);return ts}\n// === END OE PATCH HELPERS ===\nfunction createToolLoopHarness(e){",
  },
  {
    part: "1",
    file: "dist/src/harness/tool-loop.js",
    why: "project the assembled toolset once per model call (OPE-73)",
    expect: 1,
    find: "o.outputSchema!==void 0&&(a[FINAL_OUTPUT_TOOL_NAME]=buildFinalOutputTool(o.outputSchema));",
    replace: "__oeProjectToolSet(a);o.outputSchema!==void 0&&(a[FINAL_OUTPUT_TOOL_NAME]=buildFinalOutputTool(o.outputSchema));",
  },
  {
    part: "10",
    file: "dist/src/internal/authored-package-boundary.js",
    why: "keep a built workspace package external on the evaluation path (OPE-2276)",
    expect: 1,
    find: "if(isNodeModulesPath(e.id))return{external:!0,id:n}",
    replace: "if(isNodeModulesPath(e.id)||__oeResolvesThroughInstalledPackage(n,o,e.id))return{external:!0,id:n}",
  },
  {
    part: "10",
    file: "dist/src/internal/authored-package-boundary.js",
    why: "the __oeResolvesThroughInstalledPackage helper, on its own lines before the export statement",
    expect: 1,
    find: "}export{RESOLVE_EXTENSIONS,",
    replace: "}\n// === OE PATCH (OPE-2276) — keep a built workspace package external on the evaluation path ===\n// Patch part 10. It carries the OPE-2275 fix.\n// eve evaluates each authored file in its own rolldown bundle (bundleAuthoredModuleCode). The route\n// below keeps a bare import external only when the resolved id carries \"/node_modules/\". A workspace\n// package reaches node_modules through a symlink, and the resolver returns its REAL path, so the\n// whole package graph was inlined into every authored file's bundle and evaluated once per file.\n// On Open Everywhere that is 31 graph evaluations per cold `eve build` on eve 0.54.3 (OPE-2276).\n//\n// __oeResolvesThroughInstalledPackage adds one case: Node itself, resolving the same specifier from\n// the same importer, reaches the same package through a node_modules entry, AND the resolved file is\n// one Node can load. A workspace package that exports TypeScript fails the second test and stays\n// inlined, which is the reason eve inlines workspace packages at all.\n//\n// Only createRuntimeLoaderPackageBoundaryPlugin calls it. createGenerationPackageBoundaryPlugin is\n// untouched, so the emitted build still inlines the package and createDynamicCapabilityTransformPlugin\n// still stamps every dynamic-tool callback. The part changes only eve's CLI-side evaluation of\n// authored files (`eve build`, the compile `eve dev` runs, `eve eval` discovery). The deployed\n// server never runs that path, so the part plants no runtime marker.\nconst __oeNodeLoadableExtension=/\\.(?:mjs|cjs|js|json|node)$/;\nfunction __oeResolvesThroughInstalledPackage(e,t,n){if(!__oeNodeLoadableExtension.test(n))return!1;let r=nearestPackageRoot(n);if(r===void 0)return!1;let i=packageImportName(e),a=dirname(t);for(;;){let e=join(a,`node_modules`,i);if(existsSync(join(e,`package.json`))&&toCanonicalPath(e)===r)return!0;let t=dirname(a);if(t===a)return!1;a=t}}\nexport{RESOLVE_EXTENSIONS,",
  },
];

const MARKERS: readonly string[] = [
  "__oeProjectToolSetPatched",
  "__oeResolvesThroughInstalledPackage",
];

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = 0;
  for (;;) {
    const next = haystack.indexOf(needle, at);
    if (next === -1) return count;
    count += 1;
    at = next + needle.length;
  }
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const eveArg = args.indexOf("--eve");
const eveRoot = eveArg === -1 ? join("node_modules", "eve") : args[eveArg + 1];
if (eveRoot === undefined) {
  console.error("eve-patch-port: --eve needs a directory.");
  process.exit(2);
}
if (!apply && !args.includes("--check")) {
  console.error("eve-patch-port: pass --check or --apply.");
  process.exit(2);
}

const version = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;
console.log(`eve-patch-port: ${eveRoot} is eve ${version}`);

const files = [...new Set(OPS.map((op) => op.file))];
const bytes = new Map<string, string>();
for (const file of files) bytes.set(file, readFileSync(join(eveRoot, file), "utf8"));

const already = MARKERS.filter((marker) => [...bytes.values()].some((text) => text.includes(marker)));
if (already.length > 0) {
  console.error(
    `eve-patch-port: REFUSING — ${eveRoot} already carries ${already.join(", ")}. ` +
      `A second pass inserts the helper block twice. Reinstall a pristine eve first.`,
  );
  process.exit(1);
}

const reds: string[] = [];
for (const op of OPS) {
  const found = countOccurrences(bytes.get(op.file) as string, op.find);
  const verdict = found === op.expect ? "ok" : "RED";
  console.log(`  [part ${op.part}] ${op.file}: ${found}/${op.expect} ${verdict} — ${op.why}`);
  if (found !== op.expect) {
    reds.push(
      `part ${op.part} in ${op.file}: the anchor matched ${found} time(s), expected ${op.expect}. ` +
        `Anchor: ${JSON.stringify(op.find.slice(0, 120))}`,
    );
  }
}
if (reds.length > 0) {
  console.error(`\neve-patch-port: ${reds.length} anchor(s) moved on eve ${version}. Nothing was written.`);
  for (const red of reds) console.error(`  - ${red}`);
  process.exit(1);
}

if (!apply) {
  console.log(`\neve-patch-port: every anchor located on eve ${version} (--check wrote nothing).`);
  process.exit(0);
}

for (const op of OPS) bytes.set(op.file, (bytes.get(op.file) as string).split(op.find).join(op.replace));
for (const [file, text] of bytes) writeFileSync(join(eveRoot, file), text);

const missing = MARKERS.filter((marker) => ![...bytes.values()].some((text) => text.includes(marker)));
if (missing.length > 0) {
  console.error(`eve-patch-port: wrote the files but ${missing.join(", ")} is absent. The port is wrong.`);
  process.exit(1);
}
console.log(`\neve-patch-port: ported eve ${version} — ${OPS.length} edits over ${files.length} files, every marker present.`);
