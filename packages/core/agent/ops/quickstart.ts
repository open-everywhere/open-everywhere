import { resolveOperationalSelection } from "../operational/selection.js";
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

export type PreflightTarget = "local" | "hosted";

export interface PreflightOptions {
  readonly target?: PreflightTarget;
  readonly nodeVersion?: string;
  readonly nodeRange?: string;
}

const HOSTED_STORE_ENV = {
  OE_OPERATIONAL_PROVIDER: "postgres",
  OE_MEMORY_PROVIDER: "postgres",
} as const;

function operationalStoreDetail(env: NodeJS.ProcessEnv): string {
  const { id, floor } = resolveOperationalSelection(env);
  if (floor === "pglite") return "embedded Postgres (PGlite) — the zero-wiring floor, local disk only";
  if (floor === "sqlite") return "sqlite — the deprecated floor (DATABASE_URL is set, but OE_OPERATIONAL_PROVIDER is not)";
  return id;
}

function adminAuthConfigured(env: NodeJS.ProcessEnv): boolean {
  const set = (v: string | undefined) => v !== undefined && v !== "";
  return (set(env.OE_ADMIN_OIDC_ISSUER) && set(env.OE_ADMIN_OIDC_AUDIENCE)) || env.OE_ADMIN_GITHUB === "1" || set(env.OE_ADMIN_STATIC_TOKEN);
}

export function docUrl(path: string): string {
  return `https://github.com/open-everywhere/open-everywhere/blob/main/${path}`;
}

function vercelEnvPushCommand(nameOrPair: string): string {
  const name = nameOrPair.split("=")[0];
  return `npm run -s env:pipe -- ${nameOrPair} | npx vercel env add ${name} production`;
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
  checks.push({
    name: "model: AI_GATEWAY_API_KEY",
    status: keySet ? "ok" : target === "hosted" ? "info" : "missing",
    detail: keySet
      ? "set"
      : target === "hosted"
        ? "not needed on Vercel: a deployed project authenticates to the AI Gateway with OIDC"
        : "missing",
    fix: keySet || target === "hosted" ? undefined : "Vercel → AI Gateway → API Keys, then set AI_GATEWAY_API_KEY in .env.local",
  });

  const memProvider = env.OE_MEMORY_PROVIDER ?? "git";
  const op = resolveOperationalSelection(env);
  checks.push({ name: "memory provider", status: "info", detail: memProvider });
  checks.push({ name: "operational provider", status: "info", detail: operationalStoreDetail(env) });

  if (target === "hosted") {
    const consequence: Record<string, string> = {
      OE_OPERATIONAL_PROVIDER: "on Vercel core throws at the first operational-store use (audit, spend, approvals)",
      OE_MEMORY_PROVIDER: "on Vercel core throws at the first DM or personal memory call",
    };
    const selectors: readonly [keyof typeof HOSTED_STORE_ENV, string | undefined][] = [
      ["OE_OPERATIONAL_PROVIDER", env.OE_OPERATIONAL_PROVIDER],
      ["OE_MEMORY_PROVIDER", env.OE_MEMORY_PROVIDER],
    ];
    for (const [name, actual] of selectors) {
      const value = HOSTED_STORE_ENV[name];
      const ok = actual?.trim() === value;
      checks.push({
        name: `hosted store: ${name}=${value}`,
        status: ok ? "ok" : "missing",
        detail: ok ? "set" : `${set(actual) ? `set to "${actual}"` : "unset"} — ${consequence[name]}`,
        fix: ok ? undefined : `set ${name}=${value} in .env.local (scaffold_env), and set it for Production in the Vercel project`,
      });
    }
  }

  const postgresSelected = memProvider === "postgres" || (op.id === "postgres" && op.floor === "none");
  if (target === "hosted" || postgresSelected) {
    checks.push({
      name: "DATABASE_URL (Neon)",
      status: set(env.DATABASE_URL) ? "ok" : "missing",
      detail: set(env.DATABASE_URL) ? "set" : "missing",
      fix: set(env.DATABASE_URL)
        ? undefined
        : "add Neon from the Vercel Marketplace (Vercel project → Storage → Neon → Connect): it sets DATABASE_URL on the project. Copy the same value into .env.local for the operator tools.",
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
      detail: `the ${memProvider} memory backing and the ${op.floor === "sqlite" ? "sqlite" : "embedded-Postgres"} operational store are process-local — a hosted deploy loses memory and operational state on every deploy`,
      fix: 'deploying to Vercel? run preflight with target "hosted": it needs OE_MEMORY_PROVIDER=postgres, OE_OPERATIONAL_PROVIDER=postgres and DATABASE_URL',
    });
  }

  const keyStatus = credentialKeyStatus(env[CREDENTIAL_KEY_ENV_NAME]);
  checks.push({
    name: `credential store key (${CREDENTIAL_KEY_ENV_NAME})`,
    status: keyStatus === "ok" ? "ok" : keyStatus === "malformed" || target === "hosted" ? "missing" : "info",
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
    fix: hasAdminAuth ? undefined : "optional: set OE_ADMIN_OIDC_ISSUER/_AUDIENCE (any OIDC provider) or OE_ADMIN_STATIC_TOKEN",
  });

  const ready = checks.every((c) => c.status !== "missing");
  return { checks, ready };
}

export type Goal = "local" | "slack" | "github" | "deploy";

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: "done" | "todo" | "optional";
  readonly detail: string;
  readonly command?: string;
}

export type SurfaceGoalStep = (env: NodeJS.ProcessEnv) => PlanStep;

export interface SurfaceHostedPlan {
  readonly env: readonly string[];
  readonly afterDeploy?: (env: NodeJS.ProcessEnv) => readonly PlanStep[];
}

const SURFACE_GOAL_STEPS: Record<string, { readonly step: SurfaceGoalStep; readonly hosted?: SurfaceHostedPlan }> = {};

export function registerQuickstartSurfaceGoal(goal: string, step: SurfaceGoalStep, hosted?: SurfaceHostedPlan): void {
  SURFACE_GOAL_STEPS[goal] = { step, hosted };
}

export interface PlanFacts {
  readonly vercelLinked?: boolean;
  readonly internalSurfaces?: number;
}

export function quickstartPlan(
  goal: Goal,
  env: NodeJS.ProcessEnv = process.env,
  facts: PlanFacts = {},
): { goal: Goal; steps: PlanStep[]; readyToRun: boolean } {
  const set = (v: string | undefined) => v !== undefined && v !== "";
  const steps: PlanStep[] = [];

  if (goal !== "deploy") {
    steps.push({
      id: "model",
      title: "Model credentials",
      status: set(env.AI_GATEWAY_API_KEY) ? "done" : "todo",
      detail: "The agent's models run through the Vercel AI Gateway (the stack is agent/model/stacks.ts). A local run needs a gateway key.",
      command: set(env.AI_GATEWAY_API_KEY) ? undefined : "set AI_GATEWAY_API_KEY in .env.local (Vercel → AI Gateway → API Keys)",
    });
    const surface = SURFACE_GOAL_STEPS[goal];
    if (surface) steps.push(surface.step(env));
    if (goal === "github") {
      steps.push({
        id: "github",
        title: "GitHub access",
        status: set(env.GITHUB_TOKEN) ? "done" : "todo",
        detail: "A token (repo / PR scope) for the PR tool; optionally a webhook secret for event routines.",
        command: set(env.GITHUB_TOKEN) ? undefined : "set GITHUB_TOKEN (+ optional GITHUB_WEBHOOK_SECRET)",
      });
    }
    steps.push({
      id: "run",
      title: "Run locally",
      status: "todo",
      detail:
        goal === "local"
          ? "Start the dev server and talk to the agent in its terminal UI."
          : "Start the dev server. A chat surface reaches a local server only through a public tunnel, so the surface app's URLs must name the tunnel host. To deploy instead, call quickstart with goal \"deploy\".",
      command: "npm run dev",
    });
    const readyToRun = steps.filter((s) => s.status === "todo").length === 0;
    return { goal, steps, readyToRun };
  }

  const linked = facts.vercelLinked === true;
  steps.push({
    id: "vercel-link",
    title: "Link a Vercel project",
    status: linked ? "done" : "todo",
    detail: "Every later `vercel` command acts on the linked project. Linking writes .vercel/project.json (gitignored).",
    command: linked ? undefined : "npx vercel link",
  });

  const dbOk =
    set(env.DATABASE_URL) &&
    env.OE_OPERATIONAL_PROVIDER?.trim() === HOSTED_STORE_ENV.OE_OPERATIONAL_PROVIDER &&
    env.OE_MEMORY_PROVIDER?.trim() === HOSTED_STORE_ENV.OE_MEMORY_PROVIDER;
  steps.push({
    id: "db",
    title: "Durable store (Neon)",
    status: dbOk ? "done" : "todo",
    detail:
      "A Vercel function's disk is ephemeral, so memory and operational state live in Postgres. Add Neon from the Vercel Marketplace: " +
      "Vercel project → Storage → Neon → Connect. The integration sets DATABASE_URL on the project. Copy the same value into .env.local " +
      "with the two provider selectors, so the operator tools (`secret_set`, `oe secret`) write the store the deployment reads. This step " +
      "reads .env.local only, never the Vercel project.",
    command: dbOk
      ? undefined
      : 'scaffold_env { values: { DATABASE_URL: "<the Neon connection string>", OE_OPERATIONAL_PROVIDER: "postgres", OE_MEMORY_PROVIDER: "postgres" } }',
  });

  const keyOk = credentialKeyStatus(env[CREDENTIAL_KEY_ENV_NAME]) === "ok";
  steps.push({
    id: "credential-key",
    title: "Credential store key",
    status: keyOk ? "done" : "todo",
    detail:
      "This AES-256-GCM key arms the deployment's encrypted credential store. The store holds the secrets the deployment mints for " +
      "itself (the intake-page signing key among them) and every `broker: \"db\"` credential. The deployment and the operator tools need the same value.",
    command: keyOk ? undefined : "call the ops tool `scaffold_credential_key` — it mints the key into .env.local and never prints it",
  });

  const surfaces = Object.keys(SURFACE_GOAL_STEPS).sort();
  for (const name of surfaces) steps.push(SURFACE_GOAL_STEPS[name]!.step(env));

  const vouched = (facts.internalSurfaces ?? 0) > 0;
  steps.push({
    id: "trust",
    title: "Vouch your workspace and name an admin",
    status: vouched ? "done" : "todo",
    detail:
      "Two code edits, committed with the app. Until a workspace is vouched `internal`, every room is `external` and gets no shared " +
      "memory. An admin gets the control plane's org-wide tools and the approval cards. Both take effect on the next deploy, so make them " +
      `before it. ${vouched ? "A surface is vouched. Confirm that `admins` names you." : "No surface is vouched yet."}`,
    command: vouched
      ? undefined
      : 'agent/identity/surfaces.ts: add `defineSurface({ key: "slack/<team-id>", trust: "internal" })`. agent/memory/config/domains/org.ts: set `admins: ["slack/<team-id>/<member-id>"]`.',
  });

  steps.push({ id: "build", title: "Build", status: "todo", detail: "`oe build` writes the slot tree, then `eve build` compiles the app. It must pass before a deploy.", command: "npm run build" });

  const push = [
    `OE_OPERATIONAL_PROVIDER=${HOSTED_STORE_ENV.OE_OPERATIONAL_PROVIDER}`,
    `OE_MEMORY_PROVIDER=${HOSTED_STORE_ENV.OE_MEMORY_PROVIDER}`,
    CREDENTIAL_KEY_ENV_NAME,
    ...surfaces.flatMap((name) => SURFACE_GOAL_STEPS[name]!.hosted?.env ?? []),
  ];
  steps.push({
    id: "env-push",
    title: "Set the deployment's environment (Production)",
    status: "todo",
    detail:
      ".env.local is gitignored and never ships: the hosted functions read the Vercel project's environment. The Neon integration " +
      "already set DATABASE_URL. Not needed on Vercel: AI_GATEWAY_API_KEY (OIDC authenticates the gateway), OE_PUBLIC_BASE_URL (the " +
      "deployment reads its production host from VERCEL_PROJECT_PRODUCTION_URL; set it only for a custom domain) and " +
      "OE_INTAKE_PAGE_SIGNING_KEY (the deployment mints it into the credential store). A variable added after a deploy reaches the " +
      "functions only on the next deploy.",
    command: push.map(vercelEnvPushCommand).join("\n"),
  });

  steps.push({
    id: "deploy",
    title: "Deploy to Vercel",
    status: "todo",
    detail: "The deploy prints the production host (https://<project>.vercel.app). A `git push` does not deploy.",
    command: "npx vercel deploy --prod",
  });

  for (const name of surfaces) steps.push(...(SURFACE_GOAL_STEPS[name]!.hosted?.afterDeploy?.(env) ?? []));

  steps.push({
    id: "admin-auth",
    title: "Control-plane auth (optional)",
    status: adminAuthConfigured(env) ? "done" : "optional",
    detail: "Only the REMOTE admin MCP needs it: it is an OAuth resource server — point it at any OIDC provider, or use a static token. The agent answers without it.",
    command: adminAuthConfigured(env) ? undefined : "set OE_ADMIN_OIDC_ISSUER/_AUDIENCE or OE_ADMIN_STATIC_TOKEN, then push it like the other variables",
  });

  steps.push({
    id: "verify",
    title: "Prove the agent answers",
    status: "todo",
    detail:
      "A moved alias is not proof: a function that dies at cold start still shows Ready. The check posts one unsigned request to " +
      "the quickstart app's chat-surface route and passes only on a 401 whose body is `unauthorized`: that route's own refusal, so " +
      "the function booted and the route is mounted. Any other 401 or a 403 (Vercel Deployment Protection, a proxy) fails, as do " +
      "404 and 5xx. The pass does NOT prove the deployment holds the surface's signing secret: the route gives the same answer " +
      "without it. The vendor console's own URL verification proves that (see the surface's after-deploy step). Then message the " +
      "agent on the surface.",
    command: "npx create-open-everywhere --check --goal hosted --host https://<host>",
  });

  const readyToRun = steps.filter((s) => s.status === "todo").length === 0;
  return { goal, steps, readyToRun };
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
