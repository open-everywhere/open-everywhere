import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLISHABLE_PACKAGES, exportsMapFor } from "./publish-exports-generate.js";

const FORBIDDEN_LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "prepare"];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const targets = only ? PUBLISHABLE_PACKAGES.filter((p) => p === only) : [...PUBLISHABLE_PACKAGES];
if (targets.length === 0) {
  console.error(`✗ no publishable package matched --only ${only}`);
  process.exit(1);
}

const reds: string[] = [];

function run(cmd: string, args: string[], cwd = process.cwd()): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const bin = (name: string): string => join(process.cwd(), "node_modules", ".bin", name);

for (const pkgDir of targets) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, any>;
  const name = manifest.name as string;
  const fail = (msg: string): void => void reds.push(`${name}: ${msg}`);

  if (manifest.private === true) fail(`"private": true — it can never be published`);
  if (!manifest.version || manifest.version === "0.0.0") fail(`version is "${manifest.version}"`);
  if (!manifest.description) fail("no description");
  if (!manifest.license) fail("no license");
  if (!manifest.repository?.directory) fail("repository.directory is missing (monorepo packages need it)");
  if (!manifest.engines?.node) fail("no engines.node");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("no files allowlist");
  if (manifest.type !== "module") fail(`"type" is "${manifest.type}", expected "module" (OE ships ESM-only)`);
  for (const s of FORBIDDEN_LIFECYCLE) {
    if (manifest.scripts?.[s]) fail(`has a "${s}" lifecycle script — published packages must have none`);
  }
  const evePeer = manifest.peerDependencies?.eve;
  if (!evePeer) fail("eve is not a peerDependency");
  else if (!/^\d+\.\d+\.\d+$/.test(evePeer)) fail(`eve peer range "${evePeer}" is not an exact pin`);
  if (manifest.dependencies?.eve) fail("eve is also a regular dependency — it must be peer-only");
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dep.startsWith("@open-everywhere/") && !/^\d+\.\d+\.\d+$/.test(range as string)) {
      fail(`sibling dep ${dep} is "${range}" — publishable manifests need an exact version, not a workspace range`);
    }
  }
  if (JSON.stringify(manifest.exports) !== JSON.stringify(exportsMapFor(pkgDir))) {
    fail("exports map is stale — run `npx tsx scripts/publish-exports-generate.ts`");
  }
  if (!existsSync(join(pkgDir, "NOTICE"))) fail("no NOTICE at the package root (npm only auto-includes it from there)");
  if (!existsSync(join(pkgDir, "dist"))) {
    fail("dist/ is missing — run `npm run build:packages` first");
    continue;
  }

  const dest = mkdtempSync(join(tmpdir(), "oe-publish-"));
  try {
    const packed = run("npm", ["pack", "--workspace", name, "--pack-destination", dest, "--loglevel", "error"]);
    if (packed.code !== 0) {
      fail(`npm pack failed:\n${packed.out}`);
      continue;
    }
    const tgz = join(dest, packed.out.trim().split("\n").pop() ?? "");
    const listing = run("tar", ["-tzf", tgz]).out.split("\n").filter(Boolean).map((l) => l.replace(/^package\//, ""));

    if (!listing.includes("NOTICE")) fail("NOTICE is not in the tarball");
    if (!listing.some((f) => f.startsWith("dist/") && f.endsWith(".js"))) fail("no compiled dist/*.js in the tarball");
    if (!listing.some((f) => f.startsWith("dist/") && f.endsWith(".d.ts"))) fail("no dist/*.d.ts in the tarball");
    if (!listing.some((f) => f.startsWith("agent/") && f.endsWith(".ts"))) fail("no .ts sources in the tarball");
    for (const f of listing) {
      if (/(^|\/)\.env/.test(f)) fail(`tarball contains an env file: ${f}`);
      if (f.startsWith("scripts/") && f !== "scripts/oe-cli.ts") fail(`tarball contains an unexpected script: ${f}`);
    }
    for (const [subpath, target] of Object.entries(manifest.exports as Record<string, any>)) {
      const files = typeof target === "string" ? [target] : Object.values(target as Record<string, string>);
      for (const t of files) {
        const rel = (t as string).replace(/^\.\//, "");
        if (!listing.includes(rel)) fail(`export "${subpath}" points at ${rel}, which is NOT in the tarball`);
      }
    }

    const pl = run(bin("publint"), ["--strict", pkgDir]);
    if (pl.code !== 0) fail(`publint:\n${pl.out.trim()}`);
    const at = run(bin("attw"), ["--pack", pkgDir, "--profile", "esm-only"]);
    if (at.code !== 0) fail(`attw:\n${at.out.trim()}`);
    console.log(`  ${at.code === 0 && pl.code === 0 && reds.length === 0 ? "✓" : "·"} ${name}: ${listing.length} file(s) packed`);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

if (reds.length > 0) {
  console.error(`\n✗ publish gate: ${reds.length} problem(s)`);
  for (const r of reds) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`\n✓ publish gate: ${targets.length} package(s) are publish-clean (pack + publint + attw).`);
