import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { EVE_BUNDLED_ARTIFACTS_FILE, loadReadBundledCompiledArtifacts } from "./eve-deep-reads/bundled-artifacts.js";
import { EVE_HOOK_DISPATCH_FILE, loadEveHookDispatch } from "./eve-deep-reads/hook-dispatch.js";
import { EVE_DIST_SRC, EveDeepReadError, eveInternalPath } from "./eve-deep-reads/load.js";
import { EVE_MODEL_CATALOG_FILE, loadEveModelCatalog } from "./eve-deep-reads/model-catalog.js";
import { EVE_NETWORK_POLICY_FILE, loadIsSandboxNetworkPolicy } from "./eve-deep-reads/network-policy.js";
import { EVE_PREWARM_FILE, loadPrewarmAppSandboxes } from "./eve-deep-reads/prewarm.js";
import { EVE_RESOLVE_AGENT_GRAPH_FILE, loadResolveRuntimeAgentGraph } from "./eve-deep-reads/resolve-agent-graph.js";
import { EVE_RUNTIME_SESSION_FILE, assertRuntimeSessionOnGlobalSymbol } from "./eve-deep-reads/runtime-session.js";
import { EVE_SKILL_PACKAGE_FILE, loadNormalizeSkillPackage } from "./eve-deep-reads/skill-package.js";
import {
  CACHE_PATH,
  SNAPSHOT_PATH,
  assertCompiledRuntimeModelCatalogCache,
  registryModelIds,
  seedCache,
  type CompiledRuntimeModelCatalogCache,
} from "./seed-model-catalog-cache.js";

// The guard for every deliberate read of eve's internal dist/src files (scripts/eve-deep-reads/).
// Each read loads against the installed eve, each read fails loud by file name on a tree that lacks
// it, and the cache that the seed script's own writer writes round-trips through eve's own cache reader.

const repoRoot = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "oe-eve-deep-reads-"));

let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface DeepRead {
  readonly owner: string;
  readonly file: string;
  readonly probe: (root: string) => Promise<unknown>;
}

// One row per eve internal file. A new module under scripts/eve-deep-reads/ adds its row here; the
// last test below refuses a module with no row.
const DEEP_READS: readonly DeepRead[] = [
  { owner: "scripts/eve-deep-reads/prewarm.ts", file: EVE_PREWARM_FILE, probe: loadPrewarmAppSandboxes },
  { owner: "scripts/eve-deep-reads/bundled-artifacts.ts", file: EVE_BUNDLED_ARTIFACTS_FILE, probe: loadReadBundledCompiledArtifacts },
  { owner: "scripts/eve-deep-reads/resolve-agent-graph.ts", file: EVE_RESOLVE_AGENT_GRAPH_FILE, probe: loadResolveRuntimeAgentGraph },
  { owner: "scripts/eve-deep-reads/runtime-session.ts", file: EVE_RUNTIME_SESSION_FILE, probe: async (root) => assertRuntimeSessionOnGlobalSymbol(root) },
  { owner: "scripts/eve-deep-reads/model-catalog.ts", file: EVE_MODEL_CATALOG_FILE, probe: loadEveModelCatalog },
  { owner: "scripts/eve-deep-reads/skill-package.ts", file: EVE_SKILL_PACKAGE_FILE, probe: loadNormalizeSkillPackage },
  { owner: "scripts/eve-deep-reads/network-policy.ts", file: EVE_NETWORK_POLICY_FILE, probe: loadIsSandboxNetworkPolicy },
  { owner: "scripts/eve-deep-reads/hook-dispatch.ts", file: EVE_HOOK_DISPATCH_FILE, probe: loadEveHookDispatch },
];

/** A fake app root whose eve holds `file` with `body`, and nothing else. */
function fakeEveRoot(label: string, file?: string, body?: string): string {
  const root = join(scratch, label);
  mkdirSync(join(root, ...EVE_DIST_SRC), { recursive: true });
  if (file !== undefined && body !== undefined) {
    const path = eveInternalPath(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

async function rejectsByFile(probe: () => Promise<unknown>, file: string, owner: string, missing: RegExp): Promise<void> {
  await assert.rejects(probe, (err: unknown) => {
    assert.ok(err instanceof EveDeepReadError, `expected an EveDeepReadError, got ${String(err)}`);
    assert.equal(err.file, file, "the error names the eve file");
    assert.match(err.missing, missing);
    assert.ok(err.message.includes(`eve/dist/src/${file}`), "the message names the eve file");
    assert.ok(err.message.includes(owner), `the message names the module to update, ${owner}`);
    return true;
  });
}

for (const read of DEEP_READS) {
  await test(`🔴 the installed eve still carries ${read.file} with every symbol its deep read takes`, async () => {
    await read.probe(repoRoot);
  });
}

for (const read of DEEP_READS) {
  await test(`🔴 NEGATIVE: an eve with no ${read.file} fails the read loud, by file name`, async () => {
    await rejectsByFile(() => read.probe(fakeEveRoot(`gone-${read.file.replaceAll("/", "_")}`)), read.file, read.owner, /whole module/u);
  });
}

await test("🔴 NEGATIVE: an eve whose prewarm file lost its export fails the read loud, by export name", async () => {
  const root = fakeEveRoot("renamed-export", EVE_PREWARM_FILE, "export function prewarmSandboxesRenamed() {}\n");
  await rejectsByFile(() => loadPrewarmAppSandboxes(root), EVE_PREWARM_FILE, "scripts/eve-deep-reads/prewarm.ts", /prewarmAppSandboxes/u);
});

await test("🔴 NEGATIVE: an eve that keeps its runtime session module-private fails the read loud", async () => {
  const root = fakeEveRoot("private-session", EVE_RUNTIME_SESSION_FILE, "const storage = Symbol(`private`);\nexport { storage };\n");
  await rejectsByFile(async () => assertRuntimeSessionOnGlobalSymbol(root), EVE_RUNTIME_SESSION_FILE, "scripts/eve-deep-reads/runtime-session.ts", /Symbol\.for/u);
});

// --- the model catalog: eve's own reader accepts the cache the seed writes ---

const snapshot: CompiledRuntimeModelCatalogCache = (() => {
  const raw: unknown = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  assertCompiledRuntimeModelCatalogCache(raw);
  return raw;
})();
const ids = registryModelIds();

/** Runs `fn` with `globalThis.fetch` refusing every call, and returns the calls it refused. */
async function withNoNetwork(fn: () => Promise<void>): Promise<string[]> {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("this test has no network");
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

/** An app root whose cache the seed script's own writer wrote, from the committed snapshot. */
async function seededAppRoot(label: string): Promise<string> {
  const root = join(scratch, label);
  const path = await seedCache(snapshot, root);
  assert.equal(relative(root, path), relative(repoRoot, CACHE_PATH), "the seed writes to the same relative path under any root");
  return root;
}

/** An app root whose cache holds `cache` as given. Only a negative control uses this. */
function handWrittenAppRoot(label: string, cache: unknown): string {
  const root = join(scratch, label);
  const path = join(root, relative(repoRoot, CACHE_PATH));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
  return root;
}

await test("🔴 eve reads its catalog cache from the exact path the seed writes", async () => {
  const { resolveCompiledRuntimeModelCatalogCachePath } = await loadEveModelCatalog(repoRoot);
  assert.equal(resolveCompiledRuntimeModelCatalogCachePath(repoRoot), CACHE_PATH);
});

await test("🔴 HERMETIC BUILD: with no network, eve's own reader falls back to the seeded STALE cache for every registry id", async () => {
  assert.ok(ids.length > 0, "agent/model/stacks.ts named zero model ids");
  const ageMs = Date.now() - Date.parse(snapshot.fetchedAt);
  assert.ok(ageMs > 5 * 60_000, "the committed snapshot is older than eve's freshness window, so this exercises the fallback");
  const { createCompiledRuntimeModelCatalogLoader } = await loadEveModelCatalog(repoRoot);
  const root = await seededAppRoot("seeded");
  const loader = createCompiledRuntimeModelCatalogLoader(root);
  const calls = await withNoNetwork(async () => {
    for (const id of ids) {
      const entry = await loader.getModelLimits(id);
      assert.ok(entry !== null && entry.contextWindowTokens > 0, `eve resolved no context window for "${id}" from the seeded cache`);
    }
    const metadata = await loader.loadModelMetadata();
    assert.equal(metadata.fetchedAt, snapshot.fetchedAt, "the build bakes the seeded snapshot's metadata, not an empty one");
    for (const id of ids) assert.ok(metadata.models.some((m) => m.slug === id), `the baked metadata lacks "${id}"`);
  });
  assert.ok(calls.length > 0, "eve tried the network first — a stale cache is a fallback, not a hit");
});

await test("🔴 NEGATIVE: eve's own reader refuses a cache in a shape it does not know, so the round trip can fail", async () => {
  const { createCompiledRuntimeModelCatalogLoader } = await loadEveModelCatalog(repoRoot);
  const root = handWrittenAppRoot("wrong-version", { ...snapshot, version: 3 });
  const loader = createCompiledRuntimeModelCatalogLoader(root);
  await withNoNetwork(async () => {
    await assert.rejects(() => loader.getModelLimits(ids[0]!), /no network/u, "with the cache refused and no network, the lookup throws");
    const metadata = await loader.loadModelMetadata();
    assert.equal(metadata.fetchedAt, null, "eve bakes empty metadata when it refuses the cache");
  });
});

await test("🔴 every module under scripts/eve-deep-reads/ has a row in this test", async () => {
  const modules = readdirSync(join(repoRoot, "scripts", "eve-deep-reads"))
    .filter((f) => f.endsWith(".ts") && f !== "load.ts")
    .map((f) => `scripts/eve-deep-reads/${f}`)
    .sort();
  const rows = DEEP_READS.map((r) => r.owner).sort();
  assert.deepEqual(rows, modules, "each module has exactly one row, and each row names its own module");
  assert.equal(new Set(DEEP_READS.map((r) => r.file)).size, DEEP_READS.length, "no two rows probe the same eve file");
});

rmSync(scratch, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\neve-deep-reads-test: ${failed} row(s) failed.`);
  process.exit(1);
}
console.log("\neve-deep-reads-test: all rows passed.");
