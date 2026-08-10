import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const AGENT_CONFIG = "agent/agent.ts";
const EVE_PLUGIN = "node_modules/eve/dist/src/internal/nitro/host/optional-engine-dependency-plugin.js";
const ROOT_PACKAGE = "package.json";
const CODE_ROOTS = ["agent", "packages"];

const reds: string[] = [];

function optionalEnginePackages(): string[] {
  let source: string;
  try {
    source = readFileSync(EVE_PLUGIN, "utf8");
  } catch {
    reds.push(
      `UNREADABLE: ${EVE_PLUGIN} is missing. eve's optional-engine externalisation is what this gate is about; ` +
        `if the file moved in an eve bump, re-point this script (and re-read the new plugin — the list may have grown).`,
    );
    return [];
  }
  const table = /OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME\s*=\s*\{([^}]*)\}/.exec(source);
  if (!table) {
    reds.push(
      `UNREADABLE: could not find OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME in ${EVE_PLUGIN} — eve changed the shape. ` +
        `Update this gate rather than deleting it; the failure it guards (OPE-225) is a dead lambda, not a degraded feature.`,
    );
    return [];
  }
  const names = [...table[1].matchAll(/[:]\s*[`"']([^`"']+)[`"']/g)].map((m) => m[1]);
  if (names.length === 0) {
    reds.push(`UNREADABLE: OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME parsed to an empty list in ${EVE_PLUGIN}.`);
  }
  return names;
}

function runtimeFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) runtimeFiles(p, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith("-test.ts") && p.includes(`${join("", "agent")}${"/"}`)) out.push(p);
  }
  return out;
}

function importsOf(source: string): Set<string> {
  const found = new Set<string>();
  for (const re of [/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g, /(?:^|\n)\s*import\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']/g]) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return found;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const agentSource = readFileSync(AGENT_CONFIG, "utf8");
const declaredMatch = /externalDependencies\s*:\s*\[([^\]]*)\]/.exec(agentSource);
if (!declaredMatch) {
  console.log(`  (no build.externalDependencies declared in ${AGENT_CONFIG})`);
}
const declared = declaredMatch ? [...declaredMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [];

const optional = optionalEnginePackages();
const files = CODE_ROOTS.flatMap((root) => runtimeFiles(root));
const importers = new Map<string, string[]>();
for (const file of files) {
  for (const spec of importsOf(readFileSync(file, "utf8"))) {
    const name = packageNameOf(spec);
    if (!optional.includes(name)) continue;
    if (!importers.has(name)) importers.set(name, []);
    importers.get(name)?.push(file);
  }
}
for (const [name, where] of importers) {
  if (declared.includes(name)) continue;
  reds.push(
    `UNTRACED EXTERNAL: "${name}" is imported by runtime code (${where[0]}${where.length > 1 ? ` +${where.length - 1} more` : ""}) ` +
      `but is NOT in ${AGENT_CONFIG}'s build.externalDependencies. eve force-externalises it (it is an OPTIONAL SANDBOX ENGINE ` +
      `and not the configured backend) and traces nothing in, so the hosted function ships a bare import of a package that is ` +
      `not there — the lambda dies at MODULE LOAD, every route, not just this feature. Fix: ` +
      `build: { externalDependencies: [..., "${name}"] }. See OPE-225.`,
  );
}

const rootPkg = JSON.parse(readFileSync(ROOT_PACKAGE, "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const deps = new Set([...Object.keys(rootPkg.dependencies ?? {}), ...Object.keys(rootPkg.devDependencies ?? {})]);
for (const name of declared) {
  if (deps.has(name)) continue;
  reds.push(
    `PHANTOM EXTERNAL: ${AGENT_CONFIG} declares "${name}" in build.externalDependencies, but it is not a dependency in ` +
      `${ROOT_PACKAGE}. eve has nothing to trace under that name — the declaration is inert and reads as protection that ` +
      `isn't there. Fix the spelling, or drop the entry.`,
  );
}

if (reds.length > 0) {
  console.error(`✗ traced-externals: ${reds.length} problem(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ traced-externals: ${optional.length} eve optional-engine package(s) known; ${importers.size} imported by runtime code, ` +
    `all declared; ${declared.length} declared external(s) all resolve to real dependencies`,
);
