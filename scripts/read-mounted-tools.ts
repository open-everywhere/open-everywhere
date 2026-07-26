import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ToolSource } from "@open-everywhere/core/agent/access/consequence.js";
import { listDeclaredSubagents } from "@open-everywhere/core/agent/subagents/declared.js";
import { readDeclaredSubagents } from "./read-subagents.js";

export function readAuthoredTools(repoRoot: string): Map<string, ToolSource> {
  const tools = new Map<string, ToolSource>();
  const coreToolsDir = join(repoRoot, "packages", "core", "agent", "tools");
  const appToolsDir = join(repoRoot, "agent", "tools");

  for (const f of readdirSync(coreToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    const name = f.replace(/\.ts$/u, "");
    tools.set(name, { name, source: readFileSync(join(coreToolsDir, f), "utf8") });
  }

  for (const f of readdirSync(appToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    const name = f.replace(/\.ts$/u, "");
    if (tools.has(name)) continue;
    let source = readFileSync(join(appToolsDir, f), "utf8");
    const m = source.match(/export \{ default \} from "@open-everywhere\/([\w-]+)\/(.+)\.js"/u);
    if (m) {
      const pkgDir = m[1].startsWith("provider-") ? join("providers", m[1].slice("provider-".length)) : m[1];
      source = readFileSync(join(repoRoot, "packages", pkgDir, `${m[2]}.ts`), "utf8");
    }
    tools.set(name, { name, source });
  }
  return tools;
}

export async function readFrameworkToolNames(): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const { getAllFrameworkToolNames } = (await import(
    pathToFileURL(join(eveRoot, "dist/src/runtime/framework-tools/index.js")).href
  )) as { getAllFrameworkToolNames(): ReadonlySet<string> };
  return [...getAllFrameworkToolNames(), "connection_search"];
}

export function readSubagentToolNames(repoRoot: string): string[] {
  return listDeclaredSubagents(readDeclaredSubagents(repoRoot));
}

export async function readMountedToolNames(repoRoot: string): Promise<string[]> {
  const names = new Set<string>([
    ...readAuthoredTools(repoRoot).keys(),
    ...(await readFrameworkToolNames()),
    ...readSubagentToolNames(repoRoot),
  ]);
  return [...names].sort();
}
