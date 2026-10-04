import { pathToFileURL } from "node:url";

import { beginBuildStamp, finishBuildStamp, hostCacheKeyProbe, prepareCacheKey } from "../tests/integration/prepare-cache.js";

export function runBuildStamp(phase: string, root: string): string {
  if (phase !== "begin" && phase !== "end") throw new Error(`eve-build-stamp: the phase is "begin" or "end", not ${JSON.stringify(phase)}`);
  const verdict = prepareCacheKey(hostCacheKeyProbe(root));
  return phase === "begin" ? beginBuildStamp(root, verdict) : finishBuildStamp(root, verdict);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(`eve-build-stamp: ${runBuildStamp(process.argv[2] ?? "", process.cwd())}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
