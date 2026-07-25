import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DeclaredSubagentSource } from "@open-everywhere/core/agent/subagents/declared.js";

export function subagentsDir(repoRoot: string): string {
  return join(repoRoot, "agent", "subagents");
}

const MODULE_EXT = /\.(?:ts|cts|mts|js|cjs|mjs)$/u;

export function readDeclaredSubagents(repoRoot: string): DeclaredSubagentSource[] {
  const dir = subagentsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out: DeclaredSubagentSource[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile()) {
      const name = entry.name.replace(MODULE_EXT, "");
      if (name === entry.name) continue;
      out.push({
        name,
        agentSource: readFileSync(join(dir, entry.name), "utf8"),
        hasInstructions: false,
        toolFiles: new Map(),
        hookFiles: new Set(),
        directories: new Set(),
      });
      continue;
    }
    if (!entry.isDirectory()) continue;

    const rootPath = join(dir, entry.name);
    const children = readdirSync(rootPath, { withFileTypes: true });
    const agentFile = children.find((c) => c.isFile() && /^agent\.(?:ts|cts|mts|js|cjs|mjs)$/u.test(c.name));

    out.push({
      name: entry.name,
      agentSource: agentFile ? readFileSync(join(rootPath, agentFile.name), "utf8") : undefined,
      hasInstructions: children.some((c) => c.isFile() && /^instructions\.(?:md|ts|js)$/u.test(c.name)),
      toolFiles: readModuleDir(join(rootPath, "tools")),
      hookFiles: new Set(readModuleDir(join(rootPath, "hooks")).keys()),
      directories: new Set(children.filter((c) => c.isDirectory()).map((c) => c.name)),
    });
  }
  return out;
}

function readModuleDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const f of readdirSync(dir)) {
    if (!MODULE_EXT.test(f) || f.startsWith("_")) continue;
    out.set(f.replace(MODULE_EXT, ""), readFileSync(join(dir, f), "utf8"));
  }
  return out;
}
