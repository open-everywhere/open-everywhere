import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { quickstartPlan, mergeEnv } from "./quickstart.js";
import { preflightAsync } from "./probes.js";

export const OPS_TOOL_NAMES = ["preflight", "quickstart", "scaffold_env", "secret_set", "secret_list", "secret_rm"] as const;

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

export interface OpsServerDeps {
  connectStore?: (envPath: string, org: string | undefined) => Promise<{ label: string }>;
}

export function buildOpsServer(deps: OpsServerDeps = {}): McpServer {
  const server = new McpServer({ name: "open-everywhere-ops", version: "0.1.0" });
  const connectStore =
    deps.connectStore ??
    (async (envPath: string, org: string | undefined) => {
      const mod = await import("../../scripts/operator-store-connect.js");
      mod.loadRootOfTrustEnv(envPath);
      mod.declareOperatorOrg(org);
      return await mod.connectOperatorStore();
    });

  server.registerTool(
    "preflight",
    {
      title: "Preflight check",
      description: "Check the prerequisites for running/deploying Open Everywhere (node, model key, providers, durable DB, control-plane auth), plus the LIVE posture of each configured provider that registers a probe (a check env alone cannot answer, so it asks the vendor). Reads the project's .env.local. Read-only — reports what's set and how to fix what's missing.",
      inputSchema: { envPath: z.string().optional() },
    },
    async (a) => json(await preflightAsync(mergedEnv(a.envPath))),
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

  server.registerTool(
    "secret_set",
    {
      title: "Store a secret in the deployment's credential store",
      description:
        "Encrypt one or more secrets into this deployment's own credential store (AES-256-GCM, keyed by OE_CREDENTIAL_ENCRYPTION_KEY) so channels and connectors resolve them WITHOUT env vars. Write-only: no tool reads a value back, and the confirmation reports only the byte count. Needs DATABASE_URL + OE_CREDENTIAL_ENCRYPTION_KEY (from the environment or the project's .env.local).",
      inputSchema: {
        secrets: z
          .record(z.string(), z.string())
          .describe("name → value, e.g. { ACME_API_TOKEN: '<the token>' }. The name is the secretRef a credential points at."),
        org: z.string().optional().describe("override the org the rows are keyed by (default: the org this deployment declares in agent/identity/surfaces.ts)"),
        envPath: z.string().optional(),
      },
    },
    async (a) => {
      const store = await connectStore(envFilePath(a.envPath), a.org);
      const { setOperatorSecret, SET_BY_OPS_MCP } = await import("../credentials/operator-secrets.js");
      const set: unknown[] = [];
      for (const [name, value] of Object.entries(a.secrets)) {
        const r = await setOperatorSecret({ name, value, setBy: SET_BY_OPS_MCP, ...(a.org ? { org: a.org } : {}) });
        set.push({ name: r.name, bytes: r.bytes, at: r.at, replaced: r.replaced });
      }
      return json({ ok: true, store: store.label, set, note: "Values are write-only — nothing can read them back out." });
    },
  );

  server.registerTool(
    "secret_list",
    {
      title: "List stored secret NAMES",
      description: "Names, who set them and when — NEVER values or any part of one. Use it to check what a deployment already holds before setting more.",
      inputSchema: {
        includeInternal: z.boolean().optional().describe("also list host-minted internal refs (hook:/oe-oauth:/notion-handshake:)"),
        org: z.string().optional(),
        envPath: z.string().optional(),
      },
    },
    async (a) => {
      const store = await connectStore(envFilePath(a.envPath), a.org);
      const { listOperatorSecrets } = await import("../credentials/operator-secrets.js");
      const secrets = await listOperatorSecrets({ ...(a.includeInternal ? { includeInternal: true } : {}), ...(a.org ? { org: a.org } : {}) });
      return json({ store: store.label, secrets });
    },
  );

  server.registerTool(
    "secret_rm",
    {
      title: "Delete a stored secret",
      description: "Remove one secret from the credential store. The ciphertext row is DELETED, not retired — anything still resolving that name fails closed afterwards.",
      inputSchema: { name: z.string(), org: z.string().optional(), envPath: z.string().optional() },
    },
    async (a) => {
      const store = await connectStore(envFilePath(a.envPath), a.org);
      const { removeOperatorSecret } = await import("../credentials/operator-secrets.js");
      const removed = await removeOperatorSecret(a.name, a.org ? { org: a.org } : {});
      return json({ ok: removed, store: store.label, removed: removed ? [a.name] : [], ...(removed ? {} : { note: `no secret named "${a.name}" was stored` }) });
    },
  );

  return server;
}
