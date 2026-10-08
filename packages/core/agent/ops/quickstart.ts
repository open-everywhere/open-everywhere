import { resolveOperationalSelection } from "../operational/selection.js";
import { resolveMemoryProviderId } from "../memory/backing-selection.js";
import { basename, dirname } from "node:path";
import { parseEnv } from "node:util";
import { coreNodeRange, nodeRangeSatisfied } from "./package-info.js";

export type CheckStatus = "ok" | "missing" | "info";
export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

export const CREDENTIAL_KEY_ENV_NAME = "OE_CREDENTIAL_ENCRYPTION_KEY";
export const CREDENTIAL_KEY_BYTES = 32;

export type CredentialKeyStatus = "ok" | "absent" | "malformed";

export function credentialKeyStatus(raw: string | undefined): CredentialKeyStatus {
  if (raw === undefined || raw === "") return "absent";
  return Buffer.from(raw, "base64").length === CREDENTIAL_KEY_BYTES ? "ok" : "malformed";
}

export type PreflightTarget = "local" | "vercel" | "docker";

export interface PreflightOptions {
  readonly target?: PreflightTarget;
  readonly nodeVersion?: string;
  readonly nodeRange?: string;
}

const DEPLOY_STORE_ENV = {
  OE_OPERATIONAL_PROVIDER: "postgres",
  OE_MEMORY_PROVIDER: "postgres",
} as const;

function operationalStoreDetail(env: NodeJS.ProcessEnv): string {
  const { id, floor } = resolveOperationalSelection(env);
  if (floor === "pglite") return "embedded Postgres (PGlite) — the zero-wiring floor, local disk only";
  if (floor === "sqlite") return "sqlite — the deprecated floor, selected explicitly by OE_OPERATIONAL_PROVIDER=sqlite";
  if (id === "postgres" && !env.OE_OPERATIONAL_PROVIDER?.trim()) return "postgres (hosted) — derived from DATABASE_URL";
  return id;
}

function adminAuthConfigured(env: NodeJS.ProcessEnv): boolean {
  const set = (v: string | undefined) => v !== undefined && v !== "";
  return (set(env.OE_ADMIN_OIDC_ISSUER) && set(env.OE_ADMIN_OIDC_AUDIENCE)) || env.OE_ADMIN_GITHUB === "1" || set(env.OE_ADMIN_STATIC_TOKEN);
}

export function docUrl(path: string): string {
  return `https://github.com/open-everywhere/open-everywhere/blob/main/${path}`;
}

export function preflight(env: NodeJS.ProcessEnv = process.env, options: PreflightOptions = {}): { checks: Check[]; ready: boolean } {
  const target = options.target ?? "local";
  const checks: Check[] = [];
  const set = (v: string | undefined) => v !== undefined && v !== "";

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeRange = options.nodeRange ?? coreNodeRange();
  const nodeOk = nodeRange === undefined ? undefined : nodeRangeSatisfied(nodeRange, nodeVersion);
  checks.push({
    name: `node ${nodeRange ?? "(engines range unreadable)"}`,
    status: nodeOk === true ? "ok" : nodeOk === false ? "missing" : "info",
    detail:
      nodeOk === undefined
        ? `node ${nodeVersion} — this check cannot read or parse @open-everywhere/core's engines.node, so it cannot tell`
        : `node ${nodeVersion}`,
    fix: nodeOk === false ? `install a Node version that satisfies ${nodeRange} (for example \`nvm install 24 && nvm use 24\`)` : undefined,
  });

  const keySet = set(env.AI_GATEWAY_API_KEY);
  const gatewayExempt = target === "vercel";
  checks.push({
    name: "model: AI_GATEWAY_API_KEY",
    status: keySet ? "ok" : gatewayExempt ? "info" : "missing",
    detail: keySet
      ? "set"
      : gatewayExempt
        ? "not needed on Vercel: a deployed project authenticates to the AI Gateway with OIDC"
        : target === "docker"
          ? "missing — off Vercel there is no OIDC, so the model route needs this key"
          : "missing",
    fix: keySet || gatewayExempt
      ? undefined
      : target === "docker"
        ? `the person runs \`${envSetCommand("AI_GATEWAY_API_KEY")}\` in their own terminal (Vercel → AI Gateway → API Keys issues a key for any host). Running a different model backend instead? That is an adapter swap in app code, which this check cannot see — ${docUrl("docs/extending/adapter-model.md")} — so this line stays \`missing\`.`
        : `Vercel → AI Gateway → API Keys, then the person runs \`${envSetCommand("AI_GATEWAY_API_KEY")}\` in their own terminal`,
  });

  const memProvider = resolveMemoryProviderId(env);
  const op = resolveOperationalSelection(env);
  const derivedFrom = (explicit: string | undefined) => !set(explicit?.trim()) && set(env.DATABASE_URL);
  checks.push({
    name: "memory provider",
    status: "info",
    detail: derivedFrom(env.OE_MEMORY_PROVIDER) ? `${memProvider} — derived from DATABASE_URL` : memProvider,
  });
  checks.push({ name: "operational provider", status: "info", detail: operationalStoreDetail(env) });

  const deploying = target !== "local";
  if (deploying) {
    const consequence: Record<string, string> = {
      OE_OPERATIONAL_PROVIDER: "core throws at the first operational-store use (audit, spend, approvals)",
      OE_MEMORY_PROVIDER: "core throws at the first DM or personal memory call",
    };
    const resolved: readonly [keyof typeof DEPLOY_STORE_ENV, boolean, string, string | undefined][] = [
      ["OE_OPERATIONAL_PROVIDER", op.id === "postgres" && op.floor === "none", operationalStoreDetail(env), env.OE_OPERATIONAL_PROVIDER],
      ["OE_MEMORY_PROVIDER", memProvider === "postgres", memProvider, env.OE_MEMORY_PROVIDER],
    ];
    for (const [name, ok, detail, explicit] of resolved) {
      checks.push({
        name: `deploy store: ${name.replace("OE_", "").replace("_PROVIDER", "").toLowerCase()} = postgres`,
        status: ok ? "ok" : "missing",
        detail: ok
          ? derivedFrom(explicit)
            ? "postgres — derived from DATABASE_URL (no selector needed)"
            : `postgres — set explicitly as ${name}`
          : `resolves to ${detail} — ${consequence[name]}`,
        fix: ok
          ? undefined
          : `set DATABASE_URL in .env.local (the person runs \`${envSetCommand("DATABASE_URL")}\` in their own terminal) and on the deployment (${target === "docker" ? "the container's environment" : "the Vercel project"}) — ` +
            `it selects postgres for both stores on its own. A selector pointing elsewhere (${name}) overrides it and must be removed.`,
      });
    }
  }

  const postgresSelected = memProvider === "postgres" || (op.id === "postgres" && op.floor === "none");
  if (deploying || postgresSelected) {
    checks.push({
      name: "DATABASE_URL (Postgres)",
      status: set(env.DATABASE_URL) ? "ok" : "missing",
      detail: set(env.DATABASE_URL) ? "set" : "missing",
      fix: set(env.DATABASE_URL)
        ? undefined
        : target === "docker"
          ? `provision a Postgres the container can reach, then the person runs \`${envSetCommand("DATABASE_URL")}\` in their own terminal to put its connection string in .env.local for the operator tools. It selects postgres for both stores on its own.`
          : `add Neon from the Vercel Marketplace (\`npx vercel install neon\`, or the project's Storage → Neon → Connect): it sets DATABASE_URL on the project. The person puts the same value in .env.local for the operator tools: they run \`${envSetCommand("DATABASE_URL")}\` in their own terminal.`,
    });
    if (set(env.DATABASE_URL)) {
      const twoRole = set(env.OE_DB_OWNER_URL);
      checks.push({
        name: "append-only role posture",
        status: twoRole ? "ok" : "info",
        detail: twoRole ? "two-role (app runs as a non-owner runtime role)" : "single-role (owner-DDL escape open)",
        fix: twoRole ? undefined : `harden: run the two-role split so the app's credential can't disable append-only — ${docUrl("docs/extending/database.md")}`,
      });
    }
  } else {
    checks.push({
      name: "state durability",
      status: "info",
      detail: `the ${memProvider} memory backing and the ${op.floor === "sqlite" ? "sqlite" : "embedded-Postgres"} operational store are process-local — a deployment loses memory and operational state on every deploy`,
      fix: 'deploying? run preflight with target "vercel" or "docker": both need DATABASE_URL — which selects postgres for both stores on its own — and OE_CREDENTIAL_ENCRYPTION_KEY',
    });
  }

  const keyStatus = credentialKeyStatus(env[CREDENTIAL_KEY_ENV_NAME]);
  checks.push({
    name: `credential store key (${CREDENTIAL_KEY_ENV_NAME})`,
    status: keyStatus === "ok" ? "ok" : keyStatus === "malformed" || deploying ? "missing" : "info",
    detail:
      keyStatus === "ok"
        ? "armed — the encrypted credential store accepts secrets"
        : keyStatus === "malformed"
          ? `set, but it does not decode to a ${CREDENTIAL_KEY_BYTES}-byte key — the store fails closed on every read and write`
          : "unset — `secret_set`, the `oe secret` CLI and every `broker: \"db\"` credential refuse; only `broker: \"env\"` credentials resolve",
    fix:
      keyStatus === "ok"
        ? undefined
        : `set ${CREDENTIAL_KEY_ENV_NAME} to a base64-encoded ${CREDENTIAL_KEY_BYTES}-byte key — the ops MCP tool \`scaffold_credential_key\` mints one into .env.local without printing it`,
  });

  const hasAdminAuth = adminAuthConfigured(env);
  checks.push({
    name: "control-plane admin auth",
    status: hasAdminAuth ? "ok" : "info",
    detail: hasAdminAuth ? "configured" : "none — the REMOTE control plane will 401 until set (local stdio is fine)",
    fix: hasAdminAuth
      ? undefined
      : `optional: set OE_ADMIN_OIDC_ISSUER/_AUDIENCE with scaffold_env (any OIDC provider), or the person runs \`${envSetCommand("OE_ADMIN_STATIC_TOKEN")}\` in their own terminal`,
  });

  const ready = checks.every((c) => c.status !== "missing");
  return { checks, ready };
}

export const ENV_CONFIG_NAMES = [
  "OE_OPERATIONAL_PROVIDER",
  "OE_MEMORY_PROVIDER",
  "OE_PUBLIC_BASE_URL",
  "OE_ADMIN_OIDC_ISSUER",
  "OE_ADMIN_OIDC_AUDIENCE",
  "OE_ADMIN_GITHUB",
] as const;

export const PREFLIGHT_SECRET_NAMES = [
  "AI_GATEWAY_API_KEY",
  "DATABASE_URL",
  "OE_DB_OWNER_URL",
  CREDENTIAL_KEY_ENV_NAME,
  "OE_ADMIN_STATIC_TOKEN",
] as const;

export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function envSetCommand(name: string): string {
  return `npx oe env set ${name}`;
}

export function envAssignmentValue(value: string): string | undefined {
  if (/[\r\n]/.test(value)) return undefined;
  for (const candidate of [value, `'${value}'`, `"${value}"`, `\`${value}\``]) {
    if (parseEnv(`X=${candidate}`).X === value) return candidate;
  }
  return undefined;
}

const WRITABLE_ENV_NAMES = /^\.env$|^\.env\.local$|^\.env\..+\.local$/;

export function envFileTargetRefusal(file: string, projectRoot: string): string | undefined {
  if (dirname(file) !== projectRoot) {
    return `refusing to write to "${file}" — it resolves outside the project root (${projectRoot}). The target must sit at the project root.`;
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

export function mergeEnv(existing: string, values: Readonly<Record<string, string>>): string {
  const lines = existing.length ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = /^(\s*)([A-Z0-9_]+)=/.exec(line);
    if (m && remaining.has(m[2])) {
      const key = m[2];
      const val = remaining.get(key)!;
      remaining.delete(key);
      return `${m[1]}${key}=${val}`;
    }
    return line;
  });
  if (remaining.size) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    for (const [k, v] of remaining) out.push(`${k}=${v}`);
  }
  return out.join("\n");
}
