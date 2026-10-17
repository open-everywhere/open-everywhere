import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseEnv } from "node:util";
import {
  mergeEnv,
  credentialKeyStatus,
  envAssignmentValue,
  envFileTargetRefusal,
  envSetCommand,
  CREDENTIAL_KEY_ENV_NAME,
  CREDENTIAL_KEY_BYTES,
  ENV_CONFIG_NAMES,
  ENV_NAME_PATTERN,
} from "./quickstart.js";
import { preflightAsync } from "./probes.js";
import { corePackageVersion } from "./package-info.js";
import { registeredDeploymentIdentity, deploymentOrg } from "../identity/deployment-identity.js";
import {
  DEPLOY_HOST_PLACEHOLDER,
  normalizeDeployHost,
  surfaceAppManifest,
  surfaceAppManifestSurfaces,
  surfaceAppNameProblem,
  surfaceAppPackageSource,
  surfaceAppPackageSurfaces,
} from "./surface-manifest.js";
import {
  startSurfaceAppCreate,
  surfaceAppCreateFlow,
  surfaceAppCreateNameProblem,
  surfaceAppCreateStatus,
  surfaceAppCreateSurfaces,
} from "./surface-app-create.js";

export const OPS_TOOL_NAMES = [
  "preflight",
  "surface_manifest",
  "surface_app_package",
  "surface_app_create",
  "scaffold_env",
  "scaffold_credential_key",
  "secret_set",
  "secret_list",
  "secret_rm",
  "sovereignty",
] as const;

function projectDir(): string {
  return resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}
function envFilePath(path?: string): string {
  return path === undefined ? join(projectDir(), ".env.local") : resolve(projectDir(), path);
}

function envTargetRefusal(file: string): string | undefined {
  return envFileTargetRefusal(file, projectDir());
}

function projectPath(path: string): string | undefined {
  const root = projectDir();
  const file = resolve(root, path);
  const inside = (base: string, target: string): boolean => {
    const rel = relative(base, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(root, file)) return undefined;
  let existing = file;
  while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) existing = dirname(existing);
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    return undefined;
  }
  const realRoot = realpathSync(root);
  if (realExisting !== realRoot && !inside(realRoot, realExisting)) return undefined;
  return file;
}

function installedCoreVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir(), "node_modules", "@open-everywhere", "core", "package.json"), "utf-8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
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
  const loadedCore = corePackageVersion();
  const server = new McpServer({ name: "open-everywhere-ops", version: loadedCore });

  const staleCoreRefusal = () => {
    const installed = installedCoreVersion();
    if (installed === undefined || installed === loadedCore) return undefined;
    return {
      isError: true,
      ...json({
        ok: false,
        stale: { installedCore: installed, serverCore: loadedCore },
        note:
          `the app now runs @open-everywhere/core ${installed}; this ops server runs ${loadedCore}. Restart the ops server ` +
          "(in Claude Code: /mcp, then reconnect open-everywhere-ops), then call the tool again. A server that predates an " +
          "upgrade serves the old code, so nothing it returned is current.",
      }),
    };
  };
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
        target: z
          .enum(["local", "vercel", "docker"])
          .default("local")
          .describe(
            "the route this check judges against: vercel = a Vercel deploy (OIDC covers the model route, so no gateway key); " +
              "docker = a self-hosted container against the deployment contract (needs a gateway key; a different model backend is an adapter swap in app code); " +
              "local = npm run dev on this machine, the development loop and never a setup route. Both deployment routes need " +
              "the postgres stores and the credential key.",
          ),
        envPath: z.string().optional(),
      },
    },
    async (a) => json(await preflightAsync(mergedEnv(a.envPath), { target: a.target })),
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
    "surface_app_package",
    {
      title: "Chat-app package",
      description:
        "Build the upload-ready app package for a chat surface that takes one (teams): fill the manifest for this deployment, " +
        "check it against the route's listing rules, and write the zip into the project. route org = an org admin uploads it in " +
        "the admin centre; route store = a publisher submits it to the store. Returns every finding (block or warn), the filled " +
        "manifest, and the steps after the upload. A blocked package is not written. Read-only apart from the zip.",
      inputSchema: {
        surface: z.string().describe('the surface, e.g. "teams"'),
        baseUrl: z.string().describe("this deployment's public origin, e.g. https://oe.example.com"),
        route: z.enum(["org", "store"]).describe("org = admin-centre upload; store = store submission"),
        developerName: z.string().optional().describe("the publisher's name (on the store route, the Partner Center publisher name)"),
        appName: z.string().optional().describe("the app name (default: the configured identity.name)"),
        partnerId: z.string().optional().describe("the Microsoft AI Cloud Partner Program id (digits)"),
        version: z.string().optional().describe("the package version, MAJOR.MINOR.PATCH (a store update must raise it)"),
        supportContact: z.string().optional().describe("an email address or https URL where a person reports harmful AI content (store route)"),
        channelFeatures: z.enum(["omit", "tier1"]).optional().describe("store route: tier1 keeps channels (shared and private too); omit drops the channel scope"),
        icons: z
          .object({ color: z.string().optional(), outline: z.string().optional() })
          .strict()
          .optional()
          .describe('icon paths relative to the project, e.g. {"color": "brand/color.png", "outline": "brand/outline.png"}'),
        outPath: z.string().optional().describe("where to write the zip, relative to the project (default: the surface's own directory)"),
      },
    },
    (a) => {
      const source = surfaceAppPackageSource(a.surface);
      if (source === undefined) {
        const available = surfaceAppPackageSurfaces();
        return json({
          ok: false,
          surface: a.surface,
          available,
          note: available.length === 0 ? "no surface registered an app package in this process." : `no app package is registered for "${a.surface}". Registered: ${available.join(", ")}.`,
        });
      }
      const host = normalizeDeployHost(a.baseUrl);
      if (host === undefined) {
        return json({ ok: false, surface: a.surface, note: `refusing the baseUrl you passed (${a.baseUrl.length} characters) — it is not a host.` });
      }
      if (a.appName !== undefined) {
        const problem = surfaceAppNameProblem(a.surface, a.appName);
        if (problem !== undefined) return json({ ok: false, surface: a.surface, note: `refusing the appName: ${problem}.` });
      }
      const given: Readonly<Record<string, string | undefined>> = a.icons ?? {};
      const unknownIcon = Object.keys(given).find((k) => given[k] !== undefined && !(k in source.icons));
      if (unknownIcon !== undefined) {
        return json({ ok: false, surface: a.surface, note: `"${unknownIcon}" is not an icon this package takes. It takes: ${Object.keys(source.icons).join(", ")}.` });
      }
      const icons: Record<string, Uint8Array | undefined> = {};
      for (const [name, fallback] of Object.entries(source.icons)) {
        const path = projectPath(given[name] ?? fallback);
        if (path === undefined) return json({ ok: false, surface: a.surface, note: `refusing the ${name} icon path — it resolves outside the project.` });
        icons[name] = existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
      }
      const built = source.build({
        host,
        route: a.route,
        icons,
        env: mergedEnv(),
        ...(a.appName === undefined ? {} : { appName: a.appName.trim() }),
        ...(a.developerName === undefined ? {} : { developerName: a.developerName }),
        ...(a.partnerId === undefined ? {} : { partnerId: a.partnerId }),
        ...(a.version === undefined ? {} : { version: a.version }),
        ...(a.supportContact === undefined ? {} : { supportContact: a.supportContact }),
        ...(a.channelFeatures === undefined ? {} : { channelFeatures: a.channelFeatures }),
      });
      const blocked = built.findings.filter((f) => f.level === "block");
      if (blocked.length > 0 || built.archive === undefined) {
        return json({ ok: false, surface: a.surface, route: a.route, findings: built.findings, manifest: built.manifest, note: `${blocked.length} finding(s) block the package; nothing was written.` });
      }
      const outRel = a.outPath ?? join(source.outDir, built.fileName);
      const out = projectPath(outRel);
      if (out === undefined || !out.endsWith(".zip")) {
        return json({ ok: false, surface: a.surface, note: "refusing the outPath — it must be a .zip path inside the project." });
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, built.archive);
      return json({
        ok: true,
        surface: a.surface,
        route: a.route,
        path: relative(projectDir(), out),
        bytes: built.archive.byteLength,
        sha256: createHash("sha256").update(built.archive).digest("hex"),
        findings: built.findings,
        steps: built.steps,
        manifest: built.manifest,
      });
    },
  );

  server.registerTool(
    "surface_app_create",
    {
      title: "Create a surface's app in one click",
      description:
        "Create a surface's app from a generated manifest (github). action start: open a local page that sends the manifest to the " +
        "vendor; hand the person `openUrl` to open in a browser on THIS computer. They confirm the app on the vendor's site, and the " +
        "vendor's keys go straight into the project's .env.local — no value is ever returned. action status: whether the person " +
        "finished, which env names were written, and the app's install link. Refuses to overwrite env names the file already holds " +
        "unless replace is true. Needs baseUrl (the deployed host the webhook points at).",
      inputSchema: {
        surface: z.string().describe('the surface, e.g. "github"'),
        action: z.enum(["start", "status"]).default("start"),
        baseUrl: z.string().optional().describe("start: this deployment's public origin, e.g. https://oe.example.com"),
        variant: z.string().optional().describe("start: the shape of app to create (default: the surface's first; the reply lists them)"),
        appName: z.string().optional().describe("start: the app's name (default: the configured identity.name, else the project name)"),
        owner: z.string().optional().describe("start: the organization to create the app under (default: the person's own account)"),
        replace: z.boolean().optional().describe("start: overwrite env names the file already holds — the old app's keys are lost from the file"),
        path: z.string().optional().describe("override the target env file (default <project>/.env.local)"),
      },
    },
    async (a) => {
      const flow = surfaceAppCreateFlow(a.surface);
      if (flow === undefined) {
        const available = surfaceAppCreateSurfaces();
        return json({
          ok: false,
          surface: a.surface,
          available,
          note:
            available.length === 0
              ? "no surface registered a one-click app flow in this process."
              : `no one-click app flow is registered for "${a.surface}". Registered: ${available.join(", ")}. For another surface, use surface_manifest or surface_app_package.`,
        });
      }
      const variants = flow.variants.map((v) => ({ name: v.name, summary: v.summary }));
      if (a.action === "status") {
        const status = surfaceAppCreateStatus(a.surface);
        if (status === undefined) return json({ ok: false, surface: a.surface, note: "no flow was started in this ops server. Call with action start." });
        return json({ ok: status.state !== "failed" && status.state !== "expired", ...status, ...(status.state === "done" ? { after: flow.after } : {}) });
      }
      if (a.baseUrl === undefined) return json({ ok: false, surface: a.surface, note: "start needs baseUrl: the app's webhook points at the deployed host. Deploy first." });
      const host = normalizeDeployHost(a.baseUrl);
      if (host === undefined) {
        return json({ ok: false, surface: a.surface, note: `refusing the baseUrl you passed (${a.baseUrl.length} characters) — it is not a host.` });
      }
      const variant = a.variant ?? flow.variants[0]?.name;
      if (variant === undefined || !flow.variants.some((v) => v.name === variant)) {
        return json({ ok: false, surface: a.surface, variants, note: "unknown variant. Pass one of the names in variants." });
      }
      if (a.appName !== undefined) {
        const problem = surfaceAppCreateNameProblem(flow, a.appName);
        if (problem !== undefined) return json({ ok: false, surface: a.surface, note: `refusing the appName: ${problem}.` });
      }
      if (a.owner !== undefined) {
        const problem = flow.ownerProblem(a.owner);
        if (problem !== undefined) return json({ ok: false, surface: a.surface, note: `refusing the owner: ${problem}.` });
      }
      const file = envFilePath(a.path);
      const refusal = envTargetRefusal(file);
      if (refusal) return json({ ok: false, surface: a.surface, file, note: refusal });
      const writes = [...flow.envNames(variant)].sort();
      const held = loadEnvFile(file);
      const already = writes.filter((name) => (held[name] ?? "") !== "");
      if (already.length > 0 && a.replace !== true) {
        return json({
          ok: false,
          surface: a.surface,
          file,
          alreadySet: already,
          note: "the env file already holds these names, so an app is probably set up. Pass replace:true only to create a NEW app and replace them.",
        });
      }
      const writeEnv = (values: Readonly<Record<string, string>>): string | undefined => {
        const late = envTargetRefusal(file);
        if (late) return late;
        const rhs: Record<string, string> = {};
        for (const [name, value] of Object.entries(values)) {
          if (!ENV_NAME_PATTERN.test(name)) return "the vendor flow named an env key that is not an environment variable name";
          const line = envAssignmentValue(value.replace(/\r?\n/g, "\\n"));
          if (line === undefined) return `the value for ${name} cannot be written as one .env line`;
          rhs[name] = line;
        }
        const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
        const next = mergeEnv(existing, rhs);
        writeFileSync(file, next.endsWith("\n") ? next : next + "\n", { encoding: "utf-8", mode: 0o600 });
        return undefined;
      };
      const status = await startSurfaceAppCreate({
        surface: a.surface,
        flow,
        host,
        variant,
        writeEnv,
        ...(a.appName === undefined ? {} : { appName: a.appName.trim() }),
        ...(a.owner === undefined ? {} : { owner: a.owner }),
      });
      return json({
        ok: true,
        ...status,
        variants,
        file,
        writes,
        note:
          `Ask the person to open openUrl in a browser on THIS computer (it is a local page). It sends them to ${flow.vendor}, where they ` +
          "confirm the app. Then call this tool with action status. The keys go straight into the env file; none reaches this conversation.",
      });
    },
  );

  const configShape = Object.fromEntries(ENV_CONFIG_NAMES.map((name) => [name, z.string().optional()])) as Record<
    (typeof ENV_CONFIG_NAMES)[number],
    z.ZodOptional<z.ZodString>
  >;
  server.registerTool(
    "scaffold_env",
    {
      title: "Write .env.local config; name the secrets the person must set",
      description:
        `Write non-secret configuration into the project's .env.local (updating in place, appending new keys, preserving comments). ` +
        `\`values\` takes ONLY these names: ${ENV_CONFIG_NAMES.join(", ")}. A secret never passes through this tool: name it in ` +
        "`secretNames`, and the reply gives the command the person runs in their OWN terminal (`npx oe env set <NAME>`, a hidden " +
        "prompt) plus whether the file already holds a value — presence only, never any part of one. Never ask the person to paste a " +
        "secret into the chat. The target must sit at the project root and be named .env, .env.local or .env.<name>.local.",
      inputSchema: {
        values: z
          .object(configShape)
          .strict()
          .optional()
          .describe(`non-secret config to write, e.g. { OE_PUBLIC_BASE_URL: 'https://agent.example.com' }. Allowed names: ${ENV_CONFIG_NAMES.join(", ")}`),
        secretNames: z
          .array(z.string())
          .optional()
          .describe("secret NAMES the person must set, e.g. ['ACME_API_TOKEN', 'DATABASE_URL']. Never a value."),
        path: z.string().optional().describe("override the target file (default <project>/.env.local; must be a never-tracked env name at the project root)"),
      },
    },
    (a) => {
      const file = envFilePath(a.path);
      const values = Object.fromEntries(Object.entries(a.values ?? {}).filter((e): e is [string, string] => e[1] !== undefined));
      const secretNames = a.secretNames ?? [];
      const refusal = envTargetRefusal(file);
      if (refusal) return json({ ok: false, file, keysSet: [], note: refusal });
      const badAt = secretNames.findIndex((name) => !ENV_NAME_PATTERN.test(name));
      if (badAt >= 0) {
        return json({ ok: false, file, keysSet: [], note: `secretNames[${badAt}] is not an environment variable name (A-Z, 0-9 and _, starting with a letter).` });
      }
      const rhs: Record<string, string> = {};
      for (const [name, value] of Object.entries(values)) {
        const line = envAssignmentValue(value);
        if (line === undefined) return json({ ok: false, file, keysSet: [], note: `the value for ${name} holds a line break, which a .env line cannot carry.` });
        rhs[name] = line;
      }
      if (Object.keys(rhs).length > 0) {
        const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
        const next = mergeEnv(existing, rhs);
        writeFileSync(file, next.endsWith("\n") ? next : next + "\n", "utf-8");
      }
      const held = existsSync(file) ? parseEnv(readFileSync(file, "utf-8")) : {};
      const secrets = secretNames.map((name) => ({
        name,
        present: (held[name] ?? "") !== "",
        command: envSetCommand(name) + (a.path === undefined ? "" : ` --file ${file}`),
      }));
      const missing = secrets.filter((s) => !s.present);
      return json({
        ok: true,
        file,
        keysSet: Object.keys(rhs),
        ...(secrets.length > 0 ? { secrets } : {}),
        ...(missing.length > 0
          ? {
              note:
                "Ask the person to run each command below in their own terminal, from the project root. The command reads the value " +
                "from a hidden prompt and writes it to the file, so it never enters this conversation. Then call scaffold_env with the " +
                `same secretNames again to confirm: ${missing.map((s) => s.command).join(" ; ")}`,
            }
          : {}),
      });
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
      title: "Store secrets from .env.local in the deployment's credential store",
      description:
        "Encrypt one or more secrets into this deployment's own credential store (AES-256-GCM, keyed by OE_CREDENTIAL_ENCRYPTION_KEY) so channels and connectors resolve them WITHOUT env vars. Takes NAMES, never values: each value is read from the project's .env.local (or envPath), where the person put it with `npx oe env set <NAME>` in their own terminal. A name the file does not hold is refused before the store opens, and the reply names the command. Write-only: no tool reads a value back, and the confirmation reports only the byte count. Needs DATABASE_URL + OE_CREDENTIAL_ENCRYPTION_KEY (from the environment or the project's .env.local).",
      inputSchema: {
        names: z
          .array(z.string())
          .min(1)
          .describe("the secret names to store, e.g. ['ACME_API_TOKEN']. Each is the secretRef a credential points at, and each value is read from the env file."),
        org: z.string().optional().describe(ORG_INPUT_DESCRIPTION),
        envPath: z.string().optional().describe("the env file the values are read from (default <project>/.env.local; must be a never-tracked env name at the project root)"),
      },
    },
    async (a) => {
      const orgRefusal = defaultOrgRefusal(a.org);
      if (orgRefusal) return json({ ok: false, set: [], note: orgRefusal });
      const file = envFilePath(a.envPath);
      const sourceRefusal = envTargetRefusal(file);
      if (sourceRefusal) return json({ ok: false, set: [], note: sourceRefusal.replace("refusing to write to", "refusing to read secrets from") });
      const badAt = a.names.findIndex((name) => !ENV_NAME_PATTERN.test(name));
      if (badAt >= 0) {
        return json({
          ok: false,
          set: [],
          note:
            `names[${badAt}] is not an environment variable name (A-Z, 0-9 and _, starting with a letter), so no env file can hold it. ` +
            "Nothing was stored. For a store-only name, the person runs `npx oe secret set <name>` in their own terminal, value on stdin.",
        });
      }
      const held = existsSync(file) ? parseEnv(readFileSync(file, "utf-8")) : {};
      const missing = a.names.filter((name) => (held[name] ?? "") === "");
      if (missing.length > 0) {
        return json({
          ok: false,
          set: [],
          missing,
          note:
            `${file} holds no value for ${missing.join(", ")}. Nothing was stored. Ask the person to run, in their own terminal from the ` +
            `project root: ${missing.map((name) => envSetCommand(name) + (a.envPath === undefined ? "" : ` --file ${file}`)).join(" ; ")}. Then call secret_set again.`,
        });
      }
      const store = await connectStore(file, a.org);
      const { setOperatorSecret, SET_BY_OPS_MCP } = await import("../credentials/operator-secrets.js");
      const set: unknown[] = [];
      for (const name of a.names) {
        const r = await setOperatorSecret({ name, value: held[name]!, setBy: SET_BY_OPS_MCP, ...(a.org ? { org: a.org } : {}) });
        set.push({ name: r.name, bytes: r.bytes, at: r.at, replaced: r.replaced });
      }
      return json({
        ok: true,
        store: store.label,
        org: actingOrg(a.org),
        set,
        note: `Values are write-only — nothing can read them back out. They are still in ${file}; delete those lines once the deployment no longer needs them as env vars.`,
      });
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

  server.registerTool(
    "sovereignty",
    {
      title: "Sovereignty report",
      description:
        "For each piece of this deployment's data (memory, transcripts, tool-call logs, run state, audit, credentials, config, gateway, " +
        "model route, transcription, chat surface, runtime logs, telemetry, other outbound calls): where it lives, which region, which company could be " +
        "compelled to hand it over, and the config that decides it. Read from the app's own settings, roster and env; it probes nothing. " +
        "Read-only. The same map as `npx oe sovereignty`.",
      inputSchema: {
        host: z
          .enum(["vercel", "docker"])
          .optional()
          .describe("where the deployment runs. Omit it and the report reads VERCEL=1 or a linked .vercel/project.json, else says unknown."),
        envPath: z.string().optional(),
      },
    },
    async (a) => {
      const { gatherSovereigntyInput, registerAppSettings } = await import("./sovereignty-facts.js");
      const { sovereigntyReport } = await import("./sovereignty.js");
      const root = projectDir();
      const settingsProblem = await registerAppSettings(root);
      if (settingsProblem !== undefined) return { isError: true, ...json({ ok: false, note: settingsProblem }) };
      return json({ ok: true, ...sovereigntyReport(await gatherSovereigntyInput(root, mergedEnv(a.envPath), a.host)) });
    },
  );

  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> })
    ._requestHandlers;
  const sdkToolCall = handlers?.get("tools/call");
  if (handlers === undefined || sdkToolCall === undefined) {
    throw new Error("open-everywhere-ops: the MCP SDK's tools/call handler is not where this server expects it, so the stale-core guard cannot install.");
  }
  handlers.set("tools/call", async (request, extra) => staleCoreRefusal() ?? sdkToolCall(request, extra));

  return server;
}
