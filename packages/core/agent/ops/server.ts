import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { preflight, quickstartPlan, mergeEnv } from "./quickstart.js";

export const OPS_TOOL_NAMES = ["preflight", "quickstart", "scaffold_env"] as const;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}
function envFilePath(path?: string): string {
  return path ?? join(projectDir(), ".env.local");
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function mergedEnv(path?: string): NodeJS.ProcessEnv {
  return { ...process.env, ...loadEnvFile(envFilePath(path)) };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function buildOpsServer(): McpServer {
  const server = new McpServer({ name: "open-everywhere-ops", version: "0.1.0" });

  server.registerTool(
    "preflight",
    {
      title: "Preflight check",
      description: "Check the prerequisites for running/deploying OpenEverywhere (node, model key, providers, durable DB, control-plane auth). Reads the project's .env.local. Read-only — reports what's set and how to fix what's missing.",
      inputSchema: { envPath: z.string().optional() },
    },
    (a) => json(preflight(mergedEnv(a.envPath))),
  );

  server.registerTool(
    "quickstart",
    {
      title: "Quickstart plan",
      description: "Return the tailored, ordered zero→running plan for a goal, with each step marked done/todo from the current config. goal=local (eve dev), slack/github (add a surface), or deploy (hosted Vercel + Neon). Follow the steps — running commands with the user's consent (see the quickstart-open-everywhere skill).",
      inputSchema: { goal: z.enum(["local", "slack", "github", "deploy"]).default("local"), envPath: z.string().optional() },
    },
    (a) => json(quickstartPlan(a.goal, mergedEnv(a.envPath))),
  );

  server.registerTool(
    "scaffold_env",
    {
      title: "Write .env.local config",
      description: "Merge KEY=VALUE settings into the project's .env.local (updating in place, appending new keys, preserving comments). Use after gathering answers from preflight/quickstart. Writes to the adopter's project, not the plugin.",
      inputSchema: {
        values: z.record(z.string(), z.string()).describe("env keys to set, e.g. { AI_GATEWAY_API_KEY: '...', OE_OPERATIONAL_PROVIDER: 'postgres' }"),
        path: z.string().optional().describe("override the target file (default <project>/.env.local)"),
      },
    },
    (a) => {
      const file = envFilePath(a.path);
      const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
      const next = mergeEnv(existing, a.values);
      writeFileSync(file, next.endsWith("\n") ? next : next + "\n", "utf-8");
      return json({ ok: true, file, keysSet: Object.keys(a.values) });
    },
  );

  return server;
}
