import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// eve 1.x ships `compiled/@workflow/world-vercel/index.js` as a re-export of a bundled chunk, so a
// pin over the Vercel world's bytes reads the entry plus every module the entry re-exports from.
// A pin that read the entry alone would go red on a re-bundle and prove nothing about the code.
export function eveWorldVercelSource(): string {
  const evePkg = createRequire(import.meta.url).resolve("eve/package.json");
  const entryPath = join(dirname(evePkg), "dist/src/compiled/@workflow/world-vercel/index.js");
  const entry = readFileSync(entryPath, "utf8");
  const chunks = [...entry.matchAll(/from\s*"(\.[^"]+)"/g)].map((m) => readFileSync(join(dirname(entryPath), m[1]!), "utf8"));
  return [entry, ...chunks].join("\n");
}
