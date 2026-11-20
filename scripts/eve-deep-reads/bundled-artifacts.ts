import { loadEveInternalFunctions } from "./load.js";

/**
 * Deep read of `eve/dist/src/runtime/loaders/bundled-artifacts.js`.
 *
 * The integration tier's fast prewarm imports the built server bundle, then reads the compiled
 * artifacts that the bundle installed on eve's shared runtime session. No public entry exposes them.
 */
export const EVE_BUNDLED_ARTIFACTS_FILE = "runtime/loaders/bundled-artifacts.js";

const OWNER = "scripts/eve-deep-reads/bundled-artifacts.ts";

/** The fields of eve's `BundledCompiledArtifacts` that the fast prewarm reads. */
export interface BundledCompiledArtifactsView {
  readonly manifest?: unknown;
  readonly metadata?: unknown;
  readonly moduleMap?: unknown;
}

export type ReadBundledCompiledArtifacts = () => BundledCompiledArtifactsView | null | undefined;

/** Loads `readBundledCompiledArtifacts`. */
export async function loadReadBundledCompiledArtifacts(root: string): Promise<ReadBundledCompiledArtifacts> {
  const { readBundledCompiledArtifacts } = await loadEveInternalFunctions({
    root,
    file: EVE_BUNDLED_ARTIFACTS_FILE,
    names: ["readBundledCompiledArtifacts"],
    owner: OWNER,
  });
  return readBundledCompiledArtifacts as unknown as ReadBundledCompiledArtifacts;
}
