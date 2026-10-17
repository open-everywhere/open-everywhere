import {
  agentDisplayName,
  scmAppPermissionFloor,
  unionPermissions,
  SCM_MINT_JOB_SETS,
  type PermissionGrade,
  type SurfaceAppCreateFlow,
  type SurfaceAppCreateResult,
} from "@open-everywhere/core/agent/adapter-api-ops.js";
import { GITHUB_PROVIDER_EVENTS } from "./provider-events.js";

export const GITHUB_APP_NAME_MAX = 34;

const GITHUB_WEBHOOK_PATH = "/eve/v1/github";

export const EVENT_PERMISSION: Readonly<Record<string, string>> = {
  issues: "issues",
  issue_comment: "issues",
  pull_request: "pull_requests",
  pull_request_review: "pull_requests",
  pull_request_review_comment: "pull_requests",
  push: "contents",
  release: "contents",
  check_run: "checks",
  check_suite: "checks",
  workflow_run: "actions",
  workflow_job: "actions",
};

export type GithubAppVariant = "full" | "source-control";

const GITHUB_APP_VARIANTS: readonly { readonly name: GithubAppVariant; readonly summary: string }[] = [
  {
    name: "full",
    summary: "source control plus the GitHub conversational surface: the agent answers @mentions on issues and pull requests, and routines fire on repository events",
  },
  {
    name: "source-control",
    summary: "source control only: checkout, pull requests and ticket actions, with no @mention replies and no event subscriptions",
  },
];

export function githubAppEvents(variant: GithubAppVariant): string[] {
  if (variant === "source-control") return [];
  return GITHUB_PROVIDER_EVENTS.events
    .filter((e) => e.routing !== "none" && EVENT_PERMISSION[e.event] !== undefined)
    .map((e) => e.event)
    .sort();
}

export function githubAppPermissions(variant: GithubAppVariant): Record<string, PermissionGrade> {
  const eventFamilies = Object.fromEntries(githubAppEvents(variant).map((e) => [EVENT_PERMISSION[e]!, "read"]));
  return unionPermissions([scmAppPermissionFloor(), eventFamilies]);
}

export function githubAppManifest(opts: {
  readonly host: string;
  readonly variant: GithubAppVariant;
  readonly redirectUrl: string;
  readonly appName?: string;
}): Record<string, unknown> {
  const name = opts.appName ?? agentDisplayName();
  return {
    name: name.slice(0, GITHUB_APP_NAME_MAX),
    url: `https://${opts.host}`,
    description: `${name}, an agent that works in this organization's repositories.`,
    hook_attributes: { url: `https://${opts.host}${GITHUB_WEBHOOK_PATH}`, active: true },
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: githubAppPermissions(opts.variant),
    default_events: githubAppEvents(opts.variant),
  };
}

export function githubAppEnvNames(variant: GithubAppVariant): string[] {
  const scm = ["OE_GITHUB_APP_ID", "OE_GITHUB_APP_SLUG", "OE_GITHUB_APP_PRIVATE_KEY", "OE_GITHUB_APP_CLIENT_ID", "OE_GITHUB_BOT_USER_ID", "GITHUB_WEBHOOK_SECRET"];
  return variant === "full" ? [...scm, "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY"] : scm;
}

interface Conversion {
  readonly id?: unknown;
  readonly slug?: unknown;
  readonly name?: unknown;
  readonly pem?: unknown;
  readonly webhook_secret?: unknown;
  readonly client_id?: unknown;
}

const API = "https://api.github.com";
const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

export async function exchangeGithubManifestCode(opts: {
  readonly code: string;
  readonly variant: GithubAppVariant;
  readonly fetchFn: typeof fetch;
}): Promise<SurfaceAppCreateResult> {
  const res = await opts.fetchFn(`${API}/app-manifests/${encodeURIComponent(opts.code)}/conversions`, { method: "POST", headers: HEADERS });
  if (!res.ok) throw new Error(`GitHub refused the code (HTTP ${res.status}). The code is single-use and lasts one hour.`);
  let body: Conversion;
  try {
    body = (await res.json()) as Conversion;
  } catch {
    throw new Error(`GitHub's reply was not JSON (HTTP ${res.status}).`);
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
  const id = str(body.id);
  const slug = str(body.slug);
  const pem = str(body.pem);
  const webhookSecret = str(body.webhook_secret);
  const clientId = str(body.client_id);
  const missing = Object.entries({ id, slug, pem, webhook_secret: webhookSecret, client_id: clientId })
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (missing.length > 0) throw new Error(`GitHub's reply lacked ${missing.join(", ")}`);
  const env: Record<string, string> = {
    OE_GITHUB_APP_ID: id!,
    OE_GITHUB_APP_SLUG: slug!,
    OE_GITHUB_APP_PRIVATE_KEY: pem!,
    OE_GITHUB_APP_CLIENT_ID: clientId!,
    GITHUB_WEBHOOK_SECRET: webhookSecret!,
  };
  if (opts.variant === "full") {
    env.GITHUB_APP_ID = id!;
    env.GITHUB_APP_SLUG = slug!;
    env.GITHUB_APP_PRIVATE_KEY = pem!;
  }
  try {
    const bot = await opts.fetchFn(`${API}/users/${encodeURIComponent(`${slug}[bot]`)}`, { headers: HEADERS });
    const botId = bot.ok ? str(((await bot.json()) as { id?: unknown }).id) : undefined;
    if (botId !== undefined && /^\d+$/.test(botId)) env.OE_GITHUB_BOT_USER_ID = botId;
  } catch {
  }
  return { env, appName: str(body.name) ?? slug!, installUrl: `https://github.com/apps/${encodeURIComponent(slug!)}/installations/new` };
}

const isVariant = (v: string): v is GithubAppVariant => GITHUB_APP_VARIANTS.some((x) => x.name === v);

export const GITHUB_APP_CREATE_FLOW: SurfaceAppCreateFlow = {
  vendor: "GitHub",
  variants: GITHUB_APP_VARIANTS,
  appNameMax: GITHUB_APP_NAME_MAX,
  ownerProblem: (owner) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(owner) ? undefined : "it is not a GitHub organization login",
  createUrl: ({ owner, state }) =>
    owner === undefined
      ? `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`,
  manifestField: "manifest",
  manifest: ({ host, variant, redirectUrl, appName }) =>
    githubAppManifest({ host, variant: isVariant(variant) ? variant : "full", redirectUrl, ...(appName === undefined ? {} : { appName }) }),
  envNames: (variant) => githubAppEnvNames(isVariant(variant) ? variant : "full"),
  codeProblem: (code) => (/^[A-Za-z0-9_-]{1,128}$/.test(code) ? undefined : "the redirect carried no usable code"),
  exchange: ({ code, variant, fetchFn }) => exchangeGithubManifestCode({ code, variant: isVariant(variant) ? variant : "full", fetchFn }),
  after: [
    "Install the app on the repositories the agent works in: open the install link.",
    "Push each written name to the deployment's environment, piped from .env.local and never printed (the setup skill's deployment-env step), then redeploy.",
    "Optional: on the app's settings page, under Display information, upload the project mark as its logo. The manifest has no logo field.",
  ],
};

export function renderGithubAppManifestDocs(): string {
  const full = githubAppPermissions("full");
  const floor = scmAppPermissionFloor();
  const events = githubAppEvents("full");
  const label = (family: string): string => family.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const rows = Object.entries(full).map(([family, grade]) => {
    const jobs = Object.entries(SCM_MINT_JOB_SETS)
      .filter(([, set]) => (set as Record<string, string | undefined>)[family] !== undefined)
      .map(([job]) => job);
    const byEvent = events.filter((e) => EVENT_PERMISSION[e] === family);
    const why = [...jobs, ...(byEvent.length > 0 ? [`the ${byEvent.map((e) => `\`${e}\``).join(", ")} event${byEvent.length > 1 ? "s" : ""}`] : [])].join("; ");
    const scope = floor[family] === undefined ? "full App only" : "both";
    return `| ${label(family)} | ${grade === "write" ? "Read and write" : "Read-only"} | ${scope} | ${why} |`;
  });
  return [
    "| Repository permission | Access | Shape | Why |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Events (full App only): ${events.map((e) => `\`${e}\``).join(", ")}. GitHub sends \`installation\` and \`installation_repositories\` to every App with an active webhook, so neither is listed.`,
  ].join("\n");
}
