import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CoreToolExport,
  type RosterEntry,
  classifyPrimitiveSource,
  coreToolSpecifier,
  isConventionFile,
  reexportSpecifierOf,
  toolNameOf,
} from "./tool-roster.js";

function conventionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(isConventionFile)
    .sort((a, b) => a.localeCompare(b));
}

export function readCoreToolExports(coreToolsDir: string): CoreToolExport[] {
  return conventionFiles(coreToolsDir).map((f) => {
    const name = toolNameOf(f);
    return { name, specifier: coreToolSpecifier(name) };
  });
}

export function readToolRoster(appToolsDir: string): RosterEntry[] {
  return conventionFiles(appToolsDir).map((f) => {
    const source = readFileSync(join(appToolsDir, f), "utf8");
    const spec = reexportSpecifierOf(source);
    return {
      name: toolNameOf(f),
      classification: classifyPrimitiveSource(source),
      ...(spec === undefined ? {} : { reexportOf: spec }),
    };
  });
}

export function resolveCoreToolsDir(root: string): string | undefined {
  for (const rel of [
    join("node_modules", "@open-everywhere", "core", "agent", "tools"),
    join("packages", "core", "agent", "tools"),
  ]) {
    const dir = join(root, rel);
    if (existsSync(dir)) return dir;
  }
  return undefined;
}
