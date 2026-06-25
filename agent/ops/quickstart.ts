export type CheckStatus = "ok" | "missing" | "info";
export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

export function preflight(env: NodeJS.ProcessEnv = process.env): { checks: Check[]; ready: boolean } {
  const checks: Check[] = [];
  const set = (v: string | undefined) => v !== undefined && v !== "";

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node >= 20",
    status: nodeMajor >= 20 ? "ok" : "missing",
    detail: `node ${process.versions.node}`,
    fix: nodeMajor >= 20 ? undefined : "install Node 20+ (24 recommended)",
  });

  checks.push({
    name: "model: AI_GATEWAY_API_KEY",
    status: set(env.AI_GATEWAY_API_KEY) ? "ok" : "missing",
    detail: set(env.AI_GATEWAY_API_KEY) ? "set" : "missing",
    fix: "Vercel → AI Gateway → API Keys, or run `eve link`",
  });

  const memProvider = env.OE_MEMORY_PROVIDER ?? "git";
  checks.push({ name: "memory provider", status: "info", detail: memProvider });

  const opProvider = env.OE_OPERATIONAL_PROVIDER ?? "sqlite";
  checks.push({ name: "operational provider", status: "info", detail: opProvider });

  const needsDb = memProvider === "postgres" || opProvider === "postgres";
  if (needsDb) {
    checks.push({
      name: "DATABASE_URL (Neon)",
      status: set(env.DATABASE_URL) ? "ok" : "missing",
      detail: set(env.DATABASE_URL) ? "set" : "missing",
      fix: "create a Neon Postgres DB and set DATABASE_URL (register the client at startup)",
    });
  }

  const hasAdminAuth =
    (set(env.OE_ADMIN_OIDC_ISSUER) && set(env.OE_ADMIN_OIDC_AUDIENCE)) ||
    env.OE_ADMIN_GITHUB === "1" ||
    set(env.OE_ADMIN_STATIC_TOKEN);
  checks.push({
    name: "control-plane admin auth",
    status: hasAdminAuth ? "ok" : "info",
    detail: hasAdminAuth ? "configured" : "none — the REMOTE control plane will 401 until set (local stdio is fine)",
    fix: hasAdminAuth ? undefined : "set OE_ADMIN_OIDC_ISSUER/_AUDIENCE (any OIDC provider) or OE_ADMIN_STATIC_TOKEN",
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

export function quickstartPlan(goal: Goal, env: NodeJS.ProcessEnv = process.env): { goal: Goal; steps: PlanStep[]; readyToRun: boolean } {
  const set = (v: string | undefined) => v !== undefined && v !== "";
  const steps: PlanStep[] = [];

  steps.push({
    id: "model",
    title: "Model credentials",
    status: set(env.AI_GATEWAY_API_KEY) ? "done" : "todo",
    detail: "OpenEverywhere runs GLM-5.2 via the Vercel AI Gateway.",
    command: set(env.AI_GATEWAY_API_KEY) ? undefined : "set AI_GATEWAY_API_KEY in .env.local (or `eve link`)",
  });

  if (goal === "slack") {
    const ok = set(env.SLACK_BOT_TOKEN) && set(env.SLACK_SIGNING_SECRET);
    steps.push({
      id: "slack",
      title: "Slack app",
      status: ok ? "done" : "todo",
      detail: "Create a Slack app; subscribe to app_mention + message.im; copy the bot token + signing secret.",
      command: ok ? undefined : "set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET in .env.local",
    });
  }
  if (goal === "github") {
    steps.push({
      id: "github",
      title: "GitHub access",
      status: set(env.GITHUB_TOKEN) ? "done" : "todo",
      detail: "A token (repo / PR scope) for the PR tool; optionally a webhook secret for event routines.",
      command: set(env.GITHUB_TOKEN) ? undefined : "set GITHUB_TOKEN (+ optional GITHUB_WEBHOOK_SECRET)",
    });
  }

  if (goal === "deploy") {
    const dbOk = set(env.DATABASE_URL);
    steps.push({
      id: "db",
      title: "Durable store (Neon)",
      status: dbOk ? "done" : "todo",
      detail: "A hosted deploy needs Postgres for memory + operational state (org_id + RLS).",
      command: dbOk ? undefined : "create a Neon DB, set DATABASE_URL, OE_MEMORY_PROVIDER=postgres, OE_OPERATIONAL_PROVIDER=postgres",
    });
    const authOk =
      (set(env.OE_ADMIN_OIDC_ISSUER) && set(env.OE_ADMIN_OIDC_AUDIENCE)) ||
      env.OE_ADMIN_GITHUB === "1" ||
      set(env.OE_ADMIN_STATIC_TOKEN);
    steps.push({
      id: "admin-auth",
      title: "Control-plane auth",
      status: authOk ? "done" : "todo",
      detail: "The remote admin MCP is an OAuth resource server — point it at any OIDC provider, or use a static token.",
      command: authOk ? undefined : "set OE_ADMIN_OIDC_ISSUER/_AUDIENCE or OE_ADMIN_STATIC_TOKEN",
    });
    steps.push({ id: "build", title: "Build", status: "todo", detail: "Compile the Eve app.", command: "npm run build" });
    steps.push({ id: "deploy", title: "Deploy to Vercel", status: "todo", detail: "Ship it; wire the webhook URLs back to Slack/GitHub.", command: "vercel deploy --prod" });
  } else {
    steps.push({
      id: "run",
      title: "Run locally",
      status: "todo",
      detail: "Start the dev server; mention the agent (or hit the local webhook) to try it.",
      command: "npm run dev",
    });
  }

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
