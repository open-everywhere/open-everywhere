import { readFileSync } from "node:fs";
import {
  SNAPSHOT_PATH,
  assertCompiledRuntimeModelCatalogCache,
  findCatalogModelBySlug,
  modelCatalogLimitsFromProvider,
  registryModelIds,
  type CatalogModel,
  type CompiledRuntimeModelCatalogCache,
} from "./seed-model-catalog-cache.js";

let passed = 0;
const reds: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else reds.push(label);
}

function idsWithLimits(models: readonly CatalogModel[], ids: readonly string[]): { id: string; ok: boolean }[] {
  return ids.map((id) => {
    const entry = findCatalogModelBySlug(models, id);
    if (!entry) return { id, ok: false };
    const resolved = entry.providers.some((p) => modelCatalogLimitsFromProvider(p) !== null);
    return { id, ok: resolved };
  });
}

const raw: unknown = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));

let snapshot: CompiledRuntimeModelCatalogCache;
try {
  assertCompiledRuntimeModelCatalogCache(raw);
  snapshot = raw;
  passed++;
} catch (e) {
  reds.push(`${SNAPSHOT_PATH} does not satisfy this repo's copy of eve's cache-v2 shape: ${(e as Error).message}`);
  snapshot = raw as CompiledRuntimeModelCatalogCache;
}

const ids = registryModelIds();
ok(ids.length > 0, "agent/model/stacks.ts named zero model ids — registryModelIds() is broken or every stack is empty.");

for (const { id, ok: resolved } of idsWithLimits(snapshot.models, ids)) {
  ok(
    resolved,
    `registry id "${id}" (agent/model/stacks.ts) does not resolve limits from the committed snapshot ` +
      `(${SNAPSHOT_PATH}). Run \`npm run seed:model-catalog -- --refresh\` to re-trim it, or the next ` +
      `hermetic build for this id will fail once .eve/cache falls back to this snapshot.`,
  );
}

{
  const victimId = ids[0];
  if (victimId === undefined) {
    reds.push("negative control skipped — registryModelIds() returned no ids to remove.");
  } else {
    const mutilated: CatalogModel[] = snapshot.models.filter(
      (m) => findCatalogModelBySlug([m], victimId) === undefined,
    );
    const removedCount = snapshot.models.length - mutilated.length;
    ok(removedCount === 1, `negative control setup: expected to remove exactly one model entry for "${victimId}", removed ${removedCount}.`);

    const afterRemoval = idsWithLimits(mutilated, ids);
    const victimResult = afterRemoval.find((r) => r.id === victimId);
    ok(
      victimResult !== undefined && victimResult.ok === false,
      `negative control FAILED: removing "${victimId}" from a copy of the snapshot should make the drift ` +
        `check report it missing, but it still resolved limits — the check cannot actually detect drift.`,
    );
    const others = afterRemoval.filter((r) => r.id !== victimId);
    ok(
      others.every((r) => r.ok),
      `negative control setup: removing "${victimId}" also broke another id's resolution — the mutation ` +
        `was not scoped to one entry.`,
    );
  }
}

if (reds.length > 0) {
  console.error(`✗ model-catalog-snapshot: ${reds.length} failure(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ model-catalog-snapshot: ${passed} assertion(s) passed — every registry id (${ids.length}: ${ids.join(", ")}) ` +
    `resolves limits from the committed snapshot, the snapshot satisfies this repo's copy of eve's cache-v2 shape (eve's own reader: test:eve-deep-reads), and the ` +
    `negative control confirms the check can fail.`,
);
