import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_PACKAGE_NAME = "@open-everywhere/core";

interface CoreManifest {
  readonly engines?: { readonly node?: unknown };
}

let cached: CoreManifest | null | undefined;

function coreManifest(): CoreManifest | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as CoreManifest & { name?: unknown };
        if (pkg.name === CORE_PACKAGE_NAME) {
          cached = pkg;
          break;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    cached = null;
  }
  return cached;
}

export const CORE_PACKAGE_VERSION = "0.8.0";

export function corePackageVersion(): string {
  return CORE_PACKAGE_VERSION;
}

export function coreNodeRange(): string | undefined {
  const r = coreManifest()?.engines?.node;
  return typeof r === "string" && r.trim().length > 0 ? r.trim() : undefined;
}

export function nodeRangeSatisfied(range: string, version: string): boolean | undefined {
  const have = version.replace(/^v/, "").split(".").map((n) => Number(n));
  if (have.length < 1 || have.some((n) => !Number.isInteger(n))) return undefined;
  const [major = 0, minor = 0, patch = 0] = have;
  const parts = (s: string): [number, number, number] | undefined => {
    const m = /^(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(s.trim());
    if (!m) return undefined;
    const n = (g: string | undefined) => (g === undefined || g === "x" ? 0 : Number(g));
    return [Number(m[1]), n(m[2]), n(m[3])];
  };
  const cmp = (a: [number, number, number]): number =>
    major !== a[0] ? major - a[0] : minor !== a[1] ? minor - a[1] : patch - a[2];
  const r = range.trim();
  let m: RegExpExecArray | null;
  if ((m = /^>=\s*(.+)$/.exec(r))) {
    const p = parts(m[1]);
    return p === undefined ? undefined : cmp(p) >= 0;
  }
  if ((m = /^\^\s*(.+)$/.exec(r))) {
    const p = parts(m[1]);
    return p === undefined ? undefined : major === p[0] && cmp(p) >= 0;
  }
  if ((m = /^~\s*(.+)$/.exec(r))) {
    const p = parts(m[1]);
    return p === undefined ? undefined : major === p[0] && minor === p[1] && cmp(p) >= 0;
  }
  if ((m = /^(\d+)(?:\.x)?(?:\.x)?$/.exec(r))) return major === Number(m[1]);
  return undefined;
}
