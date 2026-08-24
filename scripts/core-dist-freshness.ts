import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_SRC_DIR = join(REPO_ROOT, "packages/core/agent");
export const CORE_DIST_DIR = join(REPO_ROOT, "packages/core/dist/agent");

export function newestMtimeMs(dir: string, exts: readonly string[]): number | undefined {
  if (!existsSync(dir)) return undefined;
  let newest: number | undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(full, exts);
      if (sub !== undefined && (newest === undefined || sub > newest)) newest = sub;
      continue;
    }
    if (!exts.some((ext) => entry.name.endsWith(ext))) continue;
    const mtime = statSync(full).mtimeMs;
    if (newest === undefined || mtime > newest) newest = mtime;
  }
  return newest;
}

export function isDistStale(srcMtimeMs: number | undefined, distMtimeMs: number | undefined): boolean {
  if (srcMtimeMs === undefined) return false;
  if (distMtimeMs === undefined) return true;
  return srcMtimeMs > distMtimeMs;
}

export function assertCoreDistFresh(): void {
  assertPackageDistFresh("packages/core", "@open-everywhere/core");
}

export function assertPackageDistFresh(pkgRelDir: string, workspace: string): void {
  const srcMtime = newestMtimeMs(join(REPO_ROOT, pkgRelDir, "agent"), [".ts"]);
  const distMtime = newestMtimeMs(join(REPO_ROOT, pkgRelDir, "dist/agent"), [".js"]);
  if (isDistStale(srcMtime, distMtime)) {
    throw new Error(
      `${pkgRelDir}/dist is stale relative to ${pkgRelDir}/agent source (OPE-888) — this test ` +
        `imports ${workspace} through the package specifier, which resolves to dist, not ` +
        `source. Run: npm run build -w ${workspace}, then re-run this test. If that does ` +
        `not clear this error, delete ${pkgRelDir}/.tsbuildinfo first (a checkout/stash can reset ` +
        "a source mtime without changing content, so tsc's incremental build skips re-emitting).",
    );
  }
}
