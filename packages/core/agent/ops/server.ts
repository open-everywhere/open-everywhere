import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { quickstartPlan, type PlanFacts, mergeEnv, credentialKeyStatus, CREDENTIAL_KEY_ENV_NAME, CREDENTIAL_KEY_BYTES } from "./quickstart.js";
import { preflightAsync } from "./probes.js";
import { corePackageVersion } from "./package-info.js";
import { registeredSurfaces } from "../identity/trust.js";
import { registeredDeploymentIdentity, deploymentOrg } from "../identity/deployment-identity.js";
import { DEPLOY_HOST_PLACEHOLDER, normalizeDeployHost, surfaceAppManifest, surfaceAppManifestSurfaces, surfaceAppNameProblem } from "./surface-manifest.js";

export const OPS_TOOL_NAMES = [
  "preflight",
  "quickstart",
  "surface_manifest",
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

function planFacts(): PlanFacts {
  let vercelLinked = false;
  try {
    const linked = JSON.parse(readFileSync(join(projectDir(), ".vercel", "project.json"), "utf-8")) as { projectId?: unknown };
    vercelLinked = typeof linked.projectId === "string" && linked.projectId.length > 0;
  } catch {
    vercelLinked = false;
  }
  return { vercelLinked, internalSurfaces: registeredSurfaces().filter((s) => s.trust === "internal").length };
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

const CORE_ENTRY_ORG_REFUSAL =
  'refusing to resolve the default org: this process never loaded the deployment\'s declared identity (agent/identity/surfaces.ts), so the org would silently be the shipped "default" — and rows written under the wrong tenant are invisible to the running agent. Run the shipped ops entry instead (the "open-everywhere-ops" server in .mcp.json, `npx tsx scripts/ops-mcp.ts`), which loads it, or name the tenant explicitly with `org`.';

function actingOrg(org: string | undefined): string {
  return org ? org : deploymentOrg();
}

const ORG_INPUT_DESCRIPTION =
  'the org the rows are keyed by. The default is the org this deployment declares in agent/identity/surfaces.ts. A process that never LOADED that declaration at boot (the core-only `npm run ops` entry) has no default: the call is refused rather than keyed under the shipped "default". Every reply echoes the org it acted on.';

export interface OpsServerDeps {
  connectStore?: (envPath: string, org: string | undefined) => Promise<{ label: string }>;
}

export function buildOpsServer(deps: OpsServerDeps = {}): McpServer {
  const server = new McpServer({ name: "open-everywhere-ops", version: corePackageVersion() ?? "unknown" });
  const identityDeclaredAtBoot = registeredDeploymentIdentity() !== undefined;
  const defaultOrgRefusal = (org: string | undefined): string | undefined => {
    if (org) return undefined;
    return identityDeclaredAtBoot ? undefined : CORE_ENTRY_ORG_REFUSAL;
  };
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
      inputSchema: {
        target: z.enum(["local", "hosted"]).default("local").describe("local = npm run dev on this machine; hosted = a Vercel deploy (requires the postgres stores and the credential key, and does not require a gateway key)"),
        envPath: z.string().optional(),
      },
    },
    async (a) => json(await preflightAsync(mergedEnv(a.envPath), { target: a.target })),
  );

  server.registerTool(
    "quickstart",
    {
      title: "Quickstart plan",
      description: "Return the tailored, ordered zero→running plan for a goal, with each step marked done/todo from the current config. goal=local (npm run dev), slack/github (add a surface to a local run), or deploy (the hosted path: Vercel + Neon + every registered surface, in order). Follow the steps — running commands with the user's consent (see the quickstart-open-everywhere skill).",
      inputSchema: { goal: z.enum(["local", "slack", "github", "deploy"]).default("local"), envPath: z.string().optional() },
    },
    (a) => json(quickstartPlan(a.goal, mergedEnv(a.envPath), planFacts())),
  );

  server.registerTool(
    "surface_manifest",
    {
      title: "Chat-app manifest",
      description:
        `Return the paste-ready app manifest for a chat surface (e.g. slack), with baseUrl substituted for the ${DEPLOY_HOST_PLACEHOLDER} ` +
        "placeholder in every request URL, plus the ordered clicks the operator makes in the vendor console and the values they " +
        "bring back. Read-only. Creating the app needs workspace-admin rights, so this is the hand-over for a step you cannot do. " +
        "Omit baseUrl before the first deploy: the manifest then keeps the placeholder, and placeholdersRemaining says how many " +
        "the operator must still replace by hand. Pass appName to name the app (a second install in one workspace needs its own " +
        "name); omit it for the default name.",
      inputSchema: {
        surface: z.string().describe("the surface goal, e.g. \"slack\""),
        baseUrl: z.string().optional().describe("this deployment's public origin, e.g. https://oe.example.com (scheme optional)"),
        appName: z.string().optional().describe("the chat app's name, e.g. \"Acme Agent\" (default: the surface's own default name)"),
      },
    },
    (a) => {
      const available = surfaceAppManifestSurfaces();
      let host: string | undefined;
      if (a.baseUrl !== undefined) {
        host = normalizeDeployHost(a.baseUrl);
        if (host === undefined) {
          return json({
            ok: false,
            surface: a.surface,
            note:
              `refusing to substitute the baseUrl you passed (${a.baseUrl.length} characters) — it is not a host. Pass this ` +
              "deployment's origin: letters, digits, dots and hyphens, with an optional :port and an optional scheme. Not a " +
              "path, and not a full webhook URL. The vendor rejects a malformed request URL at verification time.",
          });
        }
      }
      if (a.appName !== undefined) {
        const problem = surfaceAppNameProblem(a.surface, a.appName);
        if (problem !== undefined) return json({ ok: false, surface: a.surface, note: `refusing the appName: ${problem}.` });
      }
      const resolved = surfaceAppManifest(a.surface, {
        ...(host === undefined ? {} : { host }),
        ...(a.appName === undefined ? {} : { appName: a.appName }),
      });
      if (resolved === undefined) {
        return json({
          ok: false,
          surface: a.surface,
          available,
          note:
            available.length === 0
              ? "no surface registered an app manifest in this process — the shipped entry is scripts/ops-mcp.ts, which registers the bundles before serving."
              : `no app manifest is registered for "${a.surface}". Registered: ${available.join(", ")}.`,
        });
      }
      return json({ ok: true, available, ...resolved });
    },
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
        org: z.string().optional().describe(ORG_INPUT_DESCRIPTION),
        envPath: z.string().optional(),
      },
    },
    async (a) => {
      const orgRefusal = defaultOrgRefusal(a.org);
      if (orgRefusal) return json({ ok: false, set: [], note: orgRefusal });
      const store = await connectStore(envFilePath(a.envPath), a.org);
      const { setOperatorSecret, SET_BY_OPS_MCP } = await import("../credentials/operator-secrets.js");
      const set: unknown[] = [];
      for (const [name, value] of Object.entries(a.secrets)) {
        const r = await setOperatorSecret({ name, value, setBy: SET_BY_OPS_MCP, ...(a.org ? { org: a.org } : {}) });
        set.push({ name: r.name, bytes: r.bytes, at: r.at, replaced: r.replaced });
      }
      return json({ ok: true, store: store.label, org: actingOrg(a.org), set, note: "Values are write-only — nothing can read them back out." });
    },
  );

  server.registerTool(
    "secret_list",
    {
      title: "List stored secret NAMES",
      description: "Names, who set them and when — NEVER values or any part of one. Use it to check what a deployment already holds before setting more.",
      inputSchema: {
        includeInternal: z.boolean().optional().describe("also list host-minted internal refs (hook:/oe-oauth:/notion-handshake:)"),
        org: z.string().optional().describe(ORG_INPUT_DESCRIPTION),
        envPath: z.string().optional(),
      },
    },
    async (a) => {
      const orgRefusal = defaultOrgRefusal(a.org);
      if (orgRefusal) return json({ ok: false, secrets: [], note: orgRefusal });
      const store = await connectStore(envFilePath(a.envPath), a.org);
      const { listOperatorSecrets } = await import("../credentials/operator-secrets.js");
      const secrets = await listOperatorSecrets({ ...(a.includeInternal ? { includeInternal: true } : {}), ...(a.org ? { org: a.org } : {}) });
      return json({ store: store.label, org: actingOrg(a.org), secrets });
    },
  );

  server.registerTool(
    "secret_rm",
    {
      title: "Delete a stored secret",
      description:
        "Remove one secret from the credential store. The ciphertext row is DELETED, not retired — anything still resolving that name fails closed afterwards, UNLESS the process that RESOLVES it holds an environment variable of the same name, which resolution falls back to by design. `envFallbackPresent` reports whether THIS ops process holds one — presence only, never any part of a value. It cannot see the deployment's own host, so check that host's variables too when the deployment runs elsewhere.",
      inputSchema: { name: z.string(), org: z.string().optional().describe(ORG_INPUT_DESCRIPTION), envPath: z.string().optional() },
    },
    async (a) => {
      const orgRefusal = defaultOrgRefusal(a.org);
      if (orgRefusal) return json({ ok: false, removed: [], note: orgRefusal });
      const store = await connectStore(envFilePath(a.envPath), a.org);
      const { removeOperatorSecret, operatorSecretEnvFallbackPresent } = await import("../credentials/operator-secrets.js");
      const removed = await removeOperatorSecret(a.name, a.org ? { org: a.org } : {});
      const envFallbackPresent = operatorSecretEnvFallbackPresent(a.name);
      const notes: string[] = [];
      if (!removed) notes.push(`no secret named "${a.name}" was stored.`);
      if (envFallbackPresent) {
        notes.push(
          `An environment variable named "${a.name}" is set in THIS ops process, so that name still resolves here — from the environment, not the store. Delete the variable too to retire the value. The deployment's own host may hold one as well; this reply cannot see it.`,
        );
      }
      return json({
        ok: removed,
        store: store.label,
        org: actingOrg(a.org),
        removed: removed ? [a.name] : [],
        envFallbackPresent,
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      });
    },
  );

  return server;
}
