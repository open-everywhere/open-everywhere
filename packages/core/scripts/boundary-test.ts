import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const VENDOR_SDK = /^(@vercel\/|@neondatabase\/|pg$|pg-pool$|mysql2?$|better-sqlite3$|@aws-sdk\/|aws-sdk$)/;
const ADAPTERS_PKG = /^@open-everywhere\/adapters(\/|$)/;
const CORE_PKG = /^@open-everywhere\/core(\/|$)/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function specifiers(file: string): string[] {
  let src = readFileSync(file, "utf-8");
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  src = src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) specs.push(m[1]);
  return specs;
}

const rel = (f: string) => f.slice(REPO_ROOT.length + 1);

{
  const coreDirs = [join(REPO_ROOT, "packages/core/agent"), join(REPO_ROOT, "packages/core/scripts")];
  const files = coreDirs.flatMap(tsFiles);
  ok(files.length > 50, `scanned core (${files.length} files)`);

  for (const f of files) {
    for (const spec of specifiers(f)) {
      ok(!VENDOR_SDK.test(spec), `core is vendor-SDK-free: ${rel(f)} imports "${spec}"`);
      ok(!ADAPTERS_PKG.test(spec), `core does not import adapters: ${rel(f)} imports "${spec}"`);
      ok(
        !/^@open-everywhere\//.test(spec) || CORE_PKG.test(spec),
        `core does not depend on a sibling package: ${rel(f)} imports "${spec}"`,
      );
    }
  }
}

{
  const files = tsFiles(join(REPO_ROOT, "packages/adapters/agent"));
  ok(files.length > 0, `scanned adapters (${files.length} files)`);

  for (const f of files) {
    for (const spec of specifiers(f)) {
      const climbsIntoCore = /\.\.\/.*\/(memory|operational|access)\//.test(spec) && !CORE_PKG.test(spec);
      ok(!climbsIntoCore, `adapters reach core via package name: ${rel(f)} imports "${spec}"`);
      ok(!/(^|\/)agent\/(tools|channels|hooks)\//.test(spec), `adapters do not import the app: ${rel(f)} imports "${spec}"`);
    }
  }
}

{
  const files = tsFiles(join(REPO_ROOT, "agent"));
  ok(files.length > 0, `scanned app (${files.length} files)`);

  for (const f of files) {
    for (const spec of specifiers(f)) {
      ok(!VENDOR_SDK.test(spec), `app stays vendor-SDK-free: ${rel(f)} imports "${spec}"`);
    }
  }
}

console.log(`✓ boundary: ${n} assertions passed (core portable; adapters via package name; app vendor-free)`);
