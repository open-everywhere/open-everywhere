import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suiteStoreReach, resetStoreReachCache, resolveImportedTs } from "./suite-store-reach-lib.js";

let checks = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  checks++;
  if (!cond) failures.push(label);
}

const root = mkdtempSync(join(tmpdir(), "oe-suite-store-reach-"));

function fixture(rel: string, body: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

try {
  fixture(
    "ingress.ts",
    [
      'import { getOperationalStore } from "./store.js";',
      "export interface Deps { readonly markSeen?: (k: string) => Promise<boolean> }",
      "async function liveMarkSeen(key: string): Promise<boolean> {",
      "  return await getOperationalStore().markEventSeen(key);",
      "}",
      "export async function firstDispatchOfComment(commentId: string, deps: Deps = {}): Promise<boolean> {",
      "  const seen = deps.markSeen ?? liveMarkSeen;",
      "  return await seen(commentId);",
      "}",
      "export function anchorOf(id: string): string { return `anchor:${id}`; }",
    ].join("\n"),
  );
  fixture("store.ts", "export function getOperationalStore(): { markEventSeen: (k: string) => Promise<boolean> } { throw new Error('live'); }");

  const unpinned = fixture(
    "unpinned-test.ts",
    ['import { firstDispatchOfComment } from "./ingress.js";', "await firstDispatchOfComment('cmt-1', { markSeen: async () => true });"].join("\n"),
  );
  resetStoreReachCache();
  const unpinnedReach = suiteStoreReach(unpinned);
  ok(
    !unpinnedReach.direct && unpinnedReach.indirect.length === 1 && unpinnedReach.indirect[0].symbol === "firstDispatchOfComment" && !unpinnedReach.pinned,
    "🔴 OPE-1922 THE ACCEPTANCE CASE: a suite that calls a helper which calls getOperationalStore(), and pins nothing, is FLAGGED — and the finding names the symbol, because the suite's own text holds no store entry point for a reader to grep",
  );
  ok(
    !unpinnedReach.direct,
    "🔴 OPE-1922: it is flagged as INDIRECT, never direct — the distinction is what the finding's remedy text turns on, and a direct label would send a reader looking for a store call that is not in the file",
  );

  ok(
    unpinnedReach.indirect.length > 0,
    "🔴 OPE-1922: a suite that INJECTS a stub is still flagged — the reach is a property of the call it makes, not of the argument it happens to pass today",
  );

  const pinned = fixture(
    "pinned-test.ts",
    [
      'import { firstDispatchOfComment } from "./ingress.js";',
      'process.env.OE_SQLITE_PATH = "/tmp/oe-fixture/ops.sqlite3";',
      "await firstDispatchOfComment('cmt-1');",
    ].join("\n"),
  );
  resetStoreReachCache();
  const pinnedReach = suiteStoreReach(pinned);
  ok(
    pinnedReach.indirect.length === 1 && pinnedReach.pinned,
    "OPE-1922: the same suite with a store pin still REACHES the store — the pin answers the finding, it does not hide the reach, so the count the lint reports stays honest",
  );

  const importsOnly = fixture(
    "imports-only-test.ts",
    ['import { firstDispatchOfComment } from "./ingress.js";', "export type Handler = typeof firstDispatchOfComment;"].join("\n"),
  );
  resetStoreReachCache();
  ok(
    suiteStoreReach(importsOnly).indirect.length === 0,
    "🔴 OPE-1922 NEGATIVE CONTROL: importing a store-reaching function WITHOUT calling it is not a reach — the suite opens nothing, and flagging it would be the false positive that makes the gate unbelievable",
  );

  const siblingOnly = fixture("sibling-test.ts", ['import { anchorOf } from "./ingress.js";', "anchorOf('x');"].join("\n"));
  resetStoreReachCache();
  ok(
    suiteStoreReach(siblingOnly).indirect.length === 0,
    "🔴 OPE-1922 NEGATIVE CONTROL: calling a PURE export of a module that also reaches the store is not a reach — the walk follows the named function's own body, never the module's",
  );

  const direct = fixture("direct-test.ts", ['import { getOperationalStore } from "./store.js";', "getOperationalStore();"].join("\n"));
  resetStoreReachCache();
  const directReach = suiteStoreReach(direct);
  ok(
    directReach.direct && directReach.indirect.length === 0,
    "OPE-1219: a suite naming a store entry point in its own text is still DIRECT — the widening added a road, it did not move the old one",
  );

  const prose = fixture(
    "prose-test.ts",
    ["// getOperationalStore() is what this suite deliberately does NOT do.", 'const sample = "return getOperationalStore().addRoutine(r);";', "export default sample;"].join("\n"),
  );
  resetStoreReachCache();
  const proseReach = suiteStoreReach(prose);
  ok(
    !proseReach.direct && proseReach.indirect.length === 0,
    "🔴 OPE-1227: a store call inside a COMMENT or a STRING LITERAL is not a reach — `consequence-test.ts` carries exactly such a string as a fixture for another lint, and a pin added to satisfy this gate there would be a placebo",
  );

  const twoHops = fixture(
    "two-hop-test.ts",
    ['import { firstDispatchOfComment } from "./ingress.js";', "async function localWrapper(id: string) { return await firstDispatchOfComment(id); }", "await localWrapper('cmt-2');"].join("\n"),
  );
  resetStoreReachCache();
  ok(
    suiteStoreReach(twoHops).indirect.length === 1,
    "OPE-1922: a suite that calls the import from inside its OWN helper is still flagged, because the call site is in the suite's text either way — the uncovered case is a suite that never names the import at a call at all",
  );

  const workspaceSuite = fixture(
    "workspace-test.ts",
    ['import { usageForSession } from "@open-everywhere/core/agent/spend/usage-events.js";', 'await usageForSession("org", "session");'].join("\n"),
  );
  resetStoreReachCache();
  const workspaceReach = suiteStoreReach(workspaceSuite);
  ok(
    !workspaceReach.direct && workspaceReach.indirect.some((r) => r.symbol === "usageForSession"),
    "🔴 OPE-1922: a suite reaching the store through a `@open-everywhere/*` WORKSPACE specifier is flagged exactly as a relative one is — following only relative imports left two live suites unflagged, one of which really opens the ambient store",
  );
  ok(
    resolveImportedTs(workspaceSuite, "@open-everywhere/core/agent/operational/store.js")?.endsWith("packages/core/agent/operational/store.ts") === true,
    "🔴 OPE-1922: `@open-everywhere/<pkg>/<path>` resolves to the package's SOURCE `.ts`, never to the built `dist` its exports map points at — a reach walk over `dist` would answer from whatever was last built",
  );
  ok(
    resolveImportedTs(workspaceSuite, "@open-everywhere/not-a-package/agent/x.js") === undefined,
    "🔴 OPE-1922 NEGATIVE CONTROL: a specifier naming no workspace package resolves to nothing rather than to a guessed path — a wrong resolution would read some other file's bodies and answer about the wrong module",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`suite-store-reach: ${failures.length} of ${checks} checks FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`✓ suite-store-reach: ${checks} checks passed`);
