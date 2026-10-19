import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PREFIX = "attw-cache-preload";

const cliRequire = createRequire(createRequire(import.meta.url).resolve("@arethetypeswrong/cli/package.json"));
const coreRoot = dirname(cliRequire.resolve("@arethetypeswrong/core/package.json"));
const coreIndex = join(coreRoot, "dist", "index.js");
const hostModule = join(coreRoot, "dist", "internal", "multiCompilerHost.js");
for (const file of [coreIndex, hostModule]) {
  if (!existsSync(file)) throw new Error(`${PREFIX}: ${file} is gone — re-measure and update this preload`);
}
const { Package } = await import(pathToFileURL(coreIndex).href);
const { CompilerHostWrapper } = await import(pathToFileURL(hostModule).href);
if (typeof Package?.prototype?.directoryExists !== "function" || typeof Package.prototype.listFiles !== "function") {
  throw new Error(`${PREFIX}: @arethetypeswrong/core no longer has Package.directoryExists/listFiles — re-measure and update this preload`);
}
const ts = createRequire(join(coreRoot, "package.json"))("typescript");
if (typeof CompilerHostWrapper?.prototype?.createCompilerHost !== "function" || typeof ts.createModuleResolutionCache !== "function") {
  throw new Error(`${PREFIX}: attw's CompilerHostWrapper.createCompilerHost or ts.createModuleResolutionCache is gone — re-measure and update this preload`);
}

const dirIndex = new WeakMap();
Package.prototype.directoryExists = function directoryExists(path) {
  let dirs = dirIndex.get(this);
  if (!dirs) {
    dirs = new Set();
    for (const file of this.listFiles()) {
      for (let i = file.indexOf("/"); i !== -1; i = file.indexOf("/", i + 1)) dirs.add(file.slice(0, i + 1));
    }
    dirIndex.set(this, dirs);
  }
  return dirs.has(ts.ensureTrailingDirectorySeparator(path));
};

const createCompilerHost = CompilerHostWrapper.prototype.createCompilerHost;
CompilerHostWrapper.prototype.createCompilerHost = function createCompilerHostWithPackageJsonCache(...args) {
  const host = createCompilerHost.apply(this, args);
  if (typeof host.resolveModuleNameLiterals !== "function" || host.getModuleResolutionCache) {
    throw new Error(`${PREFIX}: attw's compiler host changed shape — re-measure and update this preload`);
  }
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, this.compilerOptions);
  host.getModuleResolutionCache = () => cache;
  return host;
};
