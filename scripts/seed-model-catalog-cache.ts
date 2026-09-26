import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelStack } from "../agent/model/stacks.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
const { STACKS } = await importAppModule<typeof import("../agent/model/stacks.js")>("agent/model/stacks.ts", APP_ROOT);

const REPO_ROOT = APP_ROOT;
export const SNAPSHOT_PATH = join(REPO_ROOT, "agent", "model", "model-catalog-snapshot.json");
export const CACHE_PATH = join(REPO_ROOT, ".eve", "cache", "model-catalog.json");
export const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";
export const CACHE_KIND = "eve-model-catalog-cache";

export interface CatalogModelProvider {
  provider: string;
  providerModelId: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  [extra: string]: unknown;
}

export interface CatalogModel {
  slug: string;
  providers: CatalogModelProvider[];
  [extra: string]: unknown;
}

export interface ModelCatalogResponse {
  models: CatalogModel[];
  providerAliases: Record<string, string>;
  [extra: string]: unknown;
}

export interface CompiledRuntimeModelCatalogCache {
  fetchedAt: string;
  kind: typeof CACHE_KIND;
  models: CatalogModel[];
  providerAliases: Record<string, string>;
  version: 2;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function assertCatalogModelProvider(x: unknown, path: string): asserts x is CatalogModelProvider {
  if (!isRecord(x)) throw new Error(`${path}: expected an object`);
  if (typeof x.provider !== "string" || x.provider.length < 1) throw new Error(`${path}.provider: expected a non-empty string`);
  if (typeof x.providerModelId !== "string" || x.providerModelId.length < 1) {
    throw new Error(`${path}.providerModelId: expected a non-empty string`);
  }
  if (x.contextWindowTokens !== undefined && !(Number.isInteger(x.contextWindowTokens) && (x.contextWindowTokens as number) >= 0)) {
    throw new Error(`${path}.contextWindowTokens: expected a nonnegative integer`);
  }
  if (x.maxOutputTokens !== undefined && !(Number.isInteger(x.maxOutputTokens) && (x.maxOutputTokens as number) >= 0)) {
    throw new Error(`${path}.maxOutputTokens: expected a nonnegative integer`);
  }
}

export function assertCatalogModel(x: unknown, path = "model"): asserts x is CatalogModel {
  if (!isRecord(x)) throw new Error(`${path}: expected an object`);
  if (typeof x.slug !== "string" || x.slug.length < 1) throw new Error(`${path}.slug: expected a non-empty string`);
  if (!Array.isArray(x.providers) || x.providers.length < 1) throw new Error(`${path}.providers: expected a non-empty array`);
  x.providers.forEach((p, i) => assertCatalogModelProvider(p, `${path}.providers[${i}]`));
}

function assertProviderAliases(x: unknown, path: string): asserts x is Record<string, string> {
  if (!isRecord(x)) throw new Error(`${path}: expected an object`);
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== "string") throw new Error(`${path}.${k}: expected a string`);
  }
}

export function assertModelCatalogResponse(x: unknown): asserts x is ModelCatalogResponse {
  if (!isRecord(x)) throw new Error("catalog response: expected an object");
  if (!Array.isArray(x.models)) throw new Error("catalog response.models: expected an array");
  x.models.forEach((m, i) => assertCatalogModel(m, `models[${i}]`));
  assertProviderAliases(x.providerAliases, "providerAliases");
}

export function assertCompiledRuntimeModelCatalogCache(x: unknown): asserts x is CompiledRuntimeModelCatalogCache {
  if (!isRecord(x)) throw new Error("cache: expected an object");
  const allowed = new Set(["fetchedAt", "kind", "models", "providerAliases", "version"]);
  for (const key of Object.keys(x)) {
    if (!allowed.has(key)) throw new Error(`cache: unexpected key "${key}" — eve's cache schema is .strict()`);
  }
  if (typeof x.fetchedAt !== "string") throw new Error("cache.fetchedAt: expected a string");
  if (x.kind !== CACHE_KIND) throw new Error(`cache.kind: expected ${JSON.stringify(CACHE_KIND)}, got ${JSON.stringify(x.kind)}`);
  if (!Array.isArray(x.models)) throw new Error("cache.models: expected an array");
  x.models.forEach((m, i) => assertCatalogModel(m, `cache.models[${i}]`));
  assertProviderAliases(x.providerAliases, "cache.providerAliases");
  if (x.version !== 2) throw new Error(`cache.version: expected 2, got ${JSON.stringify(x.version)}`);
}

export function normalizeCatalogModelId(id: string): string {
  return id.endsWith("-thinking") ? id.slice(0, -"-thinking".length) : id;
}

export function findCatalogModelBySlug(models: readonly CatalogModel[], slug: string): CatalogModel | undefined {
  const normalized = normalizeCatalogModelId(slug);
  return models.find((m) => m.slug === normalized);
}

export function modelCatalogLimitsFromProvider(
  provider: CatalogModelProvider,
): { contextWindowTokens: number; maxOutputTokens?: number } | null {
  if (provider.contextWindowTokens === undefined || provider.contextWindowTokens <= 0) return null;
  const limits: { contextWindowTokens: number; maxOutputTokens?: number } = {
    contextWindowTokens: provider.contextWindowTokens,
  };
  if (provider.maxOutputTokens !== undefined && provider.maxOutputTokens > 0) limits.maxOutputTokens = provider.maxOutputTokens;
  return limits;
}

export function registryModelIds(): string[] {
  const ids = new Set<string>();
  for (const stack of Object.values(STACKS) as ModelStack[]) {
    for (const spec of Object.values(stack)) ids.add(spec.id);
  }
  return [...ids].sort();
}

function trimToIds(full: ModelCatalogResponse, ids: readonly string[]): ModelCatalogResponse {
  const want = new Set(ids);
  const models = full.models.filter((m) => want.has(m.slug));
  const missing = ids.filter((id) => !models.some((m) => m.slug === id));
  if (missing.length > 0) {
    throw new Error(`the live AI Gateway catalog is missing registry id(s): ${missing.join(", ")}`);
  }
  return { models, providerAliases: full.providerAliases };
}

async function fetchLiveCatalog(): Promise<ModelCatalogResponse> {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`AI Gateway model catalog request failed with HTTP ${res.status} ${res.statusText}.`);
  }
  const body: unknown = await res.json();
  assertModelCatalogResponse(body);
  return body;
}

async function refreshSnapshot(): Promise<CompiledRuntimeModelCatalogCache> {
  console.log(`Fetching live catalog from ${CATALOG_URL} ...`);
  const live = await fetchLiveCatalog();
  const trimmed = trimToIds(live, registryModelIds());
  const snapshot: CompiledRuntimeModelCatalogCache = {
    fetchedAt: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    kind: CACHE_KIND,
    models: trimmed.models,
    providerAliases: trimmed.providerAliases,
    version: 2,
  };
  assertCompiledRuntimeModelCatalogCache(snapshot);
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`✓ wrote ${SNAPSHOT_PATH} (${snapshot.models.length} model(s), fetchedAt ${snapshot.fetchedAt})`);
  return snapshot;
}

async function readCommittedSnapshot(): Promise<CompiledRuntimeModelCatalogCache> {
  const raw: unknown = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  assertCompiledRuntimeModelCatalogCache(raw);
  return raw;
}

async function seedCache(snapshot: CompiledRuntimeModelCatalogCache): Promise<void> {
  await mkdir(join(REPO_ROOT, ".eve", "cache"), { recursive: true });
  await writeFile(CACHE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const snapshot = refresh ? await refreshSnapshot() : await readCommittedSnapshot();
  await seedCache(snapshot);
  console.log(
    `✓ seeded ${CACHE_PATH} from the committed snapshot (fetchedAt ${snapshot.fetchedAt}). ` +
      `A STALE fetchedAt is correct here — it is what exercises eve's fetch-then-fall-back-to-cache ` +
      `path honestly, and a live fetch still wins over this seed whenever the network works.`,
  );
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error("✗ seed-model-catalog-cache failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
