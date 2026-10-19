import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finishedRun, localBinCommand, npmCommand } from "./npm-command.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = pathToFileURL(join(root, "scripts", "attw-cache-preload.mjs")).href;
const PKG = "packages/providers/email";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function sh(cmd: string, args: string[], cwd: string): { code: number; out: string; err: string } {
  const r = finishedRun(spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }), `${cmd} ${args[0] ?? ""}`);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let runs = 0;
function attw(tgz: string, cwd: string, preload: boolean): { code: number; out: string; err: string } {
  const [node, args] = localBinCommand("@arethetypeswrong/cli", "attw", [tgz, "--profile", "esm-only", "--format", "json"]);
  const outFile = join(cwd, `attw-${++runs}.json`);
  const fd = openSync(outFile, "w");
  try {
    const r = finishedRun(spawnSync(node, preload ? ["--import", PRELOAD, ...args] : args, { cwd, encoding: "utf8", stdio: ["ignore", fd, "pipe"] }), `attw ${tgz}`);
    return { code: r.status, out: readFileSync(outFile, "utf8"), err: r.stderr };
  } finally {
    closeSync(fd);
  }
}

const work = mkdtempSync(join(tmpdir(), "oe-attw-preload-"));
try {
  const [npm, npmArgs] = npmCommand(["pack", "--workspace", PKG, "--pack-destination", work, "--loglevel", "error", "--ignore-scripts"]);
  const packed = sh(npm, npmArgs, root);
  ok(packed.code === 0, `npm pack ${PKG} exits 0 (${packed.err.trim()})`);
  const clean = packed.out.trim().split("\n").pop()!;

  const stock = attw(clean, work, false);
  const fast = attw(clean, work, true);
  ok(stock.code === 0, `stock attw is green on the clean ${PKG} tarball (exit ${stock.code})`);
  ok(fast.code === 0, `preloaded attw is green on the clean ${PKG} tarball (exit ${fast.code}): ${fast.err.trim()}`);
  ok(stock.out.length > 0 && stock.out === fast.out, "the clean analysis is byte-identical with and without the preload");

  const unpack = join(work, "unpacked");
  mkdirSync(unpack);
  ok(sh("tar", ["-xzf", join("..", clean)], unpack).code === 0, "the clean tarball unpacks");
  appendFileSync(join(unpack, "package", "dist", "agent", "contributions.d.ts"), '\nexport * from "./oe-2620-planted-missing.js";\n');
  ok(sh("tar", ["-czf", join("..", "planted.tgz"), "package"], unpack).code === 0, "the planted tarball packs");
  const stockRed = attw("planted.tgz", work, false);
  const fastRed = attw("planted.tgz", work, true);
  ok(stockRed.code !== 0, "stock attw reds on the planted missing import");
  ok(fastRed.code !== 0, "preloaded attw reds on the planted missing import");
  ok(fastRed.out.includes("InternalResolutionError") && fastRed.out.includes("oe-2620-planted-missing"), "the preloaded run names the planted defect");
  ok(stockRed.out === fastRed.out, "the planted analysis is byte-identical with and without the preload");

  const probe = `
    import { readFileSync } from "node:fs";
    import { createRequire } from "node:module";
    import { dirname, join } from "node:path";
    import { pathToFileURL } from "node:url";
    const cliRequire = createRequire(createRequire(join(process.cwd(), "package.json")).resolve("@arethetypeswrong/cli/package.json"));
    const coreRoot = dirname(cliRequire.resolve("@arethetypeswrong/core/package.json"));
    const { Package, createPackageFromTarballData } = await import(pathToFileURL(join(coreRoot, "dist", "index.js")).href);
    const { CompilerHostWrapper } = await import(pathToFileURL(join(coreRoot, "dist", "internal", "multiCompilerHost.js")).href);
    const ts = createRequire(join(coreRoot, "package.json"))("typescript");
    const scan = Package.prototype.directoryExists;
    await import(${JSON.stringify(PRELOAD)});
    const patched = Package.prototype.directoryExists !== scan;
    const pkg = createPackageFromTarballData(new Uint8Array(readFileSync(process.argv[1])));
    const dirs = new Set(["/", "", "/node_modules", "/node_modules/", "/nope", "/node_modules/@open-everywhere/provider-emai"]);
    for (const f of pkg.listFiles()) {
      for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) { dirs.add(f.slice(0, i)); dirs.add(f.slice(0, i + 1)); }
      dirs.add(f);
      dirs.add(f + "x");
    }
    const mismatch = [];
    for (const d of dirs) if (scan.call(pkg, d) !== pkg.directoryExists(d)) mismatch.push(d);
    const wrapper = new CompilerHostWrapper(pkg, ts.ModuleResolutionKind.Node16, ts.ModuleKind.Node16);
    const hostCache = typeof wrapper.compilerHost.getModuleResolutionCache === "function";
    console.log(JSON.stringify({ checked: dirs.size, mismatch, patched, hostCache }));
  `;
  const idx = sh(process.execPath, ["--input-type=module", "-e", probe, join(work, clean)], root);
  ok(idx.code === 0, `the directory-index probe runs (${idx.err.trim()})`);
  const { checked, mismatch, patched, hostCache } = JSON.parse(idx.out.trim().split("\n").pop()!) as {
    checked: number;
    mismatch: string[];
    patched: boolean;
    hostCache: boolean;
  };
  ok(patched && hostCache, `the preload installed both replacements (directoryExists: ${patched}, host cache: ${hostCache})`);
  ok(checked > 100, `the probe checked a real tarball's paths (${checked})`);
  ok(mismatch.length === 0, `the indexed directoryExists agrees with attw's scan (mismatches: ${mismatch.slice(0, 5).join(", ")})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`✓ attw-cache-preload: ${passed} assertion(s) — same answer with and without the preload`);
