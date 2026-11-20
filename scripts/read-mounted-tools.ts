import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSource } from "@open-everywhere/core/agent/access/consequence.js";
import { readEveFrameworkTools } from "../packages/core/scripts/eve-framework-tools.js";
import { listDeclaredSubagents } from "@open-everywhere/core/agent/subagents/declared.js";
import { readDeclaredSubagents } from "./read-subagents.js";

/**
 * A connector mount (`connections/connector-mount.ts`) is a tool FILE, not a tool: it mounts one
 * deferred tool per op of its connection, named `<connection>__<op>`. Those names are minted at
 * runtime and classified on the connector-op path (`classifyConnectorOpTier`), never by a static
 * TOOL_CONSEQUENCE row, so the file's own slug is not a mounted tool name. The roster shim of the
 * shipped Notion mount resolves to a module that calls `defineConnectorMount(`, and a declared MCP
 * server's stub calls `declaredMcpServerConnection(`.
 */
const CONNECTOR_MOUNT_SOURCE = /\bdefineConnectorMount\(|\bdeclaredMcpServerConnection\(/u;

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
    const m = source.match(/(?:export \{ default \}|import tool) from "@open-everywhere\/([\w-]+)\/(.+)\.js"/u);
    if (m) {
      const pkgDir = m[1].startsWith("provider-") ? join("providers", m[1].slice("provider-".length)) : m[1];
      source = readFileSync(join(repoRoot, "packages", pkgDir, `${m[2]}.ts`), "utf8");
    }
    if (CONNECTOR_MOUNT_SOURCE.test(source)) continue;
    tools.set(name, { name, source });
  }
  return tools;
}

export async function readFrameworkToolNames(): Promise<string[]> {
  return [...(await readEveFrameworkTools()).all];
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
