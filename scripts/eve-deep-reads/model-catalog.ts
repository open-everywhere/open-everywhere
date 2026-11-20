import { loadEveInternalFunctions } from "./load.js";

/**
 * Deep read of `eve/dist/src/compiler/model-catalog.js`.
 *
 * `eve build` resolves each configured model's context window from the AI Gateway model catalog, through
 * a disk cache at `.eve/cache/model-catalog.json`. `npm run seed:model-catalog` writes that cache from a
 * committed snapshot, so that a build with no route to the gateway still compiles. The cache schema is
 * eve-internal: no public entry exports it. This read loads eve's own cache reader, so a test can prove
 * that eve accepts the file the seed writes.
 */
export const EVE_MODEL_CATALOG_FILE = "compiler/model-catalog.js";

const OWNER = "scripts/eve-deep-reads/model-catalog.ts";

/** The fields of eve's model-catalog entry that its lookups return. */
export interface EveModelCatalogEntry {
  readonly contextWindowTokens: number;
  readonly slug: string;
}

/** The fields of eve's baked model metadata that a test reads. */
export interface EveModelMetadata {
  readonly fetchedAt: string | null;
  readonly models: readonly { readonly slug: string }[];
}

/** eve's per-build catalog loader. */
export interface EveModelCatalogLoader {
  getModelLimits(modelId: string): Promise<EveModelCatalogEntry | null>;
  loadModelMetadata(): Promise<EveModelMetadata>;
}

export interface EveModelCatalog {
  readonly createCompiledRuntimeModelCatalogLoader: (appRoot: string) => EveModelCatalogLoader;
  readonly resolveCompiledRuntimeModelCatalogCachePath: (appRoot: string) => string;
}

/** Loads eve's build-time catalog loader and the path it reads its cache from. */
export async function loadEveModelCatalog(root: string): Promise<EveModelCatalog> {
  const fns = await loadEveInternalFunctions({
    root,
    file: EVE_MODEL_CATALOG_FILE,
    names: ["createCompiledRuntimeModelCatalogLoader", "resolveCompiledRuntimeModelCatalogCachePath"],
    owner: OWNER,
  });
  return fns as unknown as EveModelCatalog;
}
