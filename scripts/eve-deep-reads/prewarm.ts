import { loadEveInternalFunctions } from "./load.js";

/**
 * Deep read of `eve/dist/src/execution/sandbox/prewarm.js`.
 *
 * No public entry exports a sandbox prewarm. `eve build` and `eve dev` call it inside the CLI only. The
 * integration tier's prepare step and the docker live test call it directly, so that the just-bash and
 * docker templates exist before the first turn.
 */
export const EVE_PREWARM_FILE = "execution/sandbox/prewarm.js";

const OWNER = "scripts/eve-deep-reads/prewarm.ts";

/** The subset of `prewarmAppSandboxes`' input that this repository passes. */
export type PrewarmAppSandboxes = (input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource?: unknown;
  readonly loadAgentGraph?: (input: never) => Promise<unknown>;
  readonly log?: (message: string) => void;
}) => Promise<void>;

/** Loads `prewarmAppSandboxes`, the only prewarm export eve ships. */
export async function loadPrewarmAppSandboxes(root: string): Promise<PrewarmAppSandboxes> {
  const { prewarmAppSandboxes } = await loadEveInternalFunctions({
    root,
    file: EVE_PREWARM_FILE,
    names: ["prewarmAppSandboxes"],
    owner: OWNER,
  });
  return prewarmAppSandboxes as unknown as PrewarmAppSandboxes;
}
