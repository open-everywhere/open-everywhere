import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { quickstartPlan, mergeEnv, credentialKeyStatus, CREDENTIAL_KEY_ENV_NAME, CREDENTIAL_KEY_BYTES } from "./quickstart.js";
import { preflightAsync } from "./probes.js";

export const OPS_TOOL_NAMES = [
  "preflight",
  "quickstart",
  "scaffold_env",
  "scaffold_credential_key",
  "secret_set",
  "secret_list",
  "secret_rm",
] as const;

function projectDir(): string {
  return resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}
function envFilePath(path?: string): string {
  return path === undefined ? join(projectDir(), ".env.local") : resolve(projectDir(), path);
}

const WRITABLE_ENV_NAMES = /^\.env$|^\.env\.local$|^\.env\..+\.local$/;

function envTargetRefusal(file: string): string | undefined {
  const dir = dirname(file);
  if (dir !== projectDir()) {
    return `refusing to write to "${file}" — it resolves outside the project root (${projectDir()}). The target must sit at the project root.`;
  }
  const base = basename(file);
  if (!WRITABLE_ENV_NAMES.test(base)) {
    return (
      `refusing to write to "${base}" — the target must be .env, .env.local or .env.<name>.local, the names this repository never ` +
      "tracks. A .env.example (or any other name) is a TRACKED file."
    );
  }
  return undefined;
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
      description:
        "Merge KEY=VALUE settings into the project's .env.local (updating in place, appending new keys, preserving comments). Use after " +
        "gathering answers from preflight/quickstart. The target must sit at the project root and be named .env, .env.local or " +
        ".env.<name>.local — the names this repository never tracks; any other name is refused, because these values are secrets and a " +
        ".env.example is a tracked file.",
      inputSchema: {
        values: z.record(z.string(), z.string()).describe("env keys to set, e.g. { AI_GATEWAY_API_KEY: '...', OE_OPERATIONAL_PROVIDER: 'postgres' }"),
        path: z.string().optional().describe("override the target file (default <project>/.env.local; must be a never-tracked env name at the project root)"),
      },
    },
    (a) => {
      const file = envFilePath(a.path);
      const refusal = envTargetRefusal(file);
      if (refusal) return json({ ok: false, file, keysSet: [], note: refusal });
      const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
      const next = mergeEnv(existing, a.values);
      writeFileSync(file, next.endsWith("\n") ? next : next + "\n", "utf-8");
      return json({ ok: true, file, keysSet: Object.keys(a.values) });
    },
  );

  server.registerTool(
    "scaffold_credential_key",
    {
      title: "Mint the credential store's encryption key",
      description:
        `Generate the deployment's AES-256-GCM credential-store key (${CREDENTIAL_KEY_ENV_NAME}) straight into the project's .env.local. ` +
        "The value is NEVER returned — the response reports the byte count only. Idempotent by default: an existing well-formed key is left " +
        "alone, because a new key orphans every secret already stored under the old one (nothing can read those rows again). A key exported " +
        "in the operator's shell is refused outright, even with `replace` — the environment wins over the file for the secret tools, so a " +
        "file key would never take effect. Run it BEFORE secret_set. The same value must reach the deployment's own environment separately " +
        "— .env.local does not ship.",
      inputSchema: {
        replace: z
          .boolean()
          .optional()
          .describe("mint a new key even though one is set in the file — every secret already in the store becomes permanently unreadable"),
        path: z.string().optional().describe("override the target file (default <project>/.env.local)"),
      },
    },
    (a) => {
      const file = envFilePath(a.path);
      const keyRefusal = envTargetRefusal(file);
      if (keyRefusal) return json({ ok: false, file, generated: false, note: keyRefusal });
      const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
      const inFile = credentialKeyStatus(loadEnvFile(file)[CREDENTIAL_KEY_ENV_NAME]);
      const inProcess = credentialKeyStatus(process.env[CREDENTIAL_KEY_ENV_NAME]);
      if (inFile === "absent" && inProcess !== "absent") {
        return json({
          ok: false,
          file,
          key: CREDENTIAL_KEY_ENV_NAME,
          generated: false,
          existing: inProcess,
          source: "environment",
          note:
            `${CREDENTIAL_KEY_ENV_NAME} is exported in this process's environment, not in ${file}. That value is the one the secret tools ` +
            "use, and it is the one the store's rows are encrypted under. Push THAT value to the deployment rather than minting a rival; " +
            "unset it and re-run only if you know the store holds nothing.",
        });
      }
      if (inFile !== "absent" && a.replace !== true) {
        return json({
          ok: true,
          file,
          key: CREDENTIAL_KEY_ENV_NAME,
          generated: false,
          existing: inFile,
          source: "file",
          note:
            inFile === "ok"
              ? "a well-formed key is already set — left alone. Pass replace:true only when you accept that every secret already stored becomes unreadable."
              : `the key already set does not decode to a ${CREDENTIAL_KEY_BYTES}-byte key, so the store is failing closed. Pass replace:true to mint a new one.`,
        });
      }
      const next = mergeEnv(existing, { [CREDENTIAL_KEY_ENV_NAME]: randomBytes(CREDENTIAL_KEY_BYTES).toString("base64") });
      writeFileSync(file, next.endsWith("\n") ? next : next + "\n", "utf-8");
      return json({
        ok: true,
        file,
        key: CREDENTIAL_KEY_ENV_NAME,
        bytes: CREDENTIAL_KEY_BYTES,
        generated: true,
        replaced: inFile !== "absent",
        note:
          "The value was written to the file and is not in this response. To arm a hosted deployment, pipe it from the file into " +
          `\`vercel env add ${CREDENTIAL_KEY_ENV_NAME} production\` rather than reading it back — nothing needs to see it.`,
      });
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
