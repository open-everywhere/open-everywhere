export const CONTRACT_NODE_RANGE = "24.x";

export const CONTRACT_REQUIREMENT_IDS = [
  "node-24",
  "public-https-url",
  "postgres",
  "sandbox-backend",
  "egress-control",
  "model-route",
  "secrets",
  "workflow-storage",
] as const;

export type ContractRequirementId = (typeof CONTRACT_REQUIREMENT_IDS)[number];

export const CONTRACT_ROUTES = ["vercel", "docker"] as const;
export type ContractRoute = (typeof CONTRACT_ROUTES)[number];

export interface ContractRequirement {
  readonly id: ContractRequirementId;
  readonly title: string;
  readonly requirement: string;
  readonly consequence: string;
  readonly routes: Readonly<Record<ContractRoute, string>>;
  readonly env?: readonly string[];
}

export const CONTRACT_VERSION = 1;

export const DEPLOYMENT_CONTRACT: readonly ContractRequirement[] = [
  {
    id: "node-24",
    title: "Node 24",
    requirement: `The host runs the app on Node ${CONTRACT_NODE_RANGE} — the range the deploying app declares in \`engines.node\` (\`@open-everywhere/core\` itself accepts \`>=24\`).`,
    consequence: "An older runtime fails at install or at the first use of a language or standard-library feature the tree assumes.",
    routes: {
      vercel: "Set the project's Node.js Version to 24.x (Project → Settings → Build and Deployment).",
      docker: "The shipped `Dockerfile` pins the base image; a hand-rolled image must match the same range.",
    },
  },
  {
    id: "public-https-url",
    title: "A public HTTPS URL",
    requirement:
      "The deployment answers on one stable, public HTTPS origin, and knows that origin — every chat vendor verifies a webhook URL, and every OAuth callback is built from it.",
    consequence:
      "Without it Slack cannot verify Event Subscriptions, no OAuth callback resolves, and an ingress a vendor cannot reach is indistinguishable from one that is down.",
    routes: {
      vercel: "The production domain. The deployment reads it from `VERCEL_PROJECT_PRODUCTION_URL`; set `OE_PUBLIC_BASE_URL` for a custom domain.",
      docker: "A TLS-terminating reverse proxy in front of the container, with `OE_PUBLIC_BASE_URL` set to the public origin.",
    },
    env: ["OE_PUBLIC_BASE_URL"],
  },
  {
    id: "postgres",
    title: "Postgres",
    requirement:
      "A Postgres database the deployment can reach, named by `DATABASE_URL`. It holds the operational store (audit chain, spend ledger, approvals, break-glass revocations) and the durable memory backing.",
    consequence:
      "On a multi-instance host a local store is per-instance: a break-glass revocation writes to one instance while the others read their own empty copy, the spend ledger resets on every cold start, and the audit trail evaporates. Core refuses to boot into that state rather than report a success-shaped lie.",
    routes: {
      vercel: "Neon from the Vercel Marketplace (Project → Storage → Neon → Connect). The integration sets `DATABASE_URL` on the project.",
      docker: "Any Postgres the container can reach — a managed service or the `docker-compose.yml` sidecar.",
    },
    env: ["DATABASE_URL"],
  },
  {
    id: "sandbox-backend",
    title: "A sandbox backend",
    requirement:
      "The agent's shell runs in a CONTAINED, per-session filesystem that is not the app process's own — a Vercel Sandbox, or Docker with the egress sidecar.",
    consequence:
      "The dev-only `justbash` backend shares the app process's filesystem, so a model holding `bash` reads the deployment's own files and environment. It is supported for development and for nothing else.",
    routes: {
      vercel: "Vercel Sandbox — selected automatically on Vercel.",
      docker: "The default off-Vercel backend. `OE_SANDBOX_BACKEND` names it explicitly; `justbash` is the dev-only opt-in.",
    },
    env: ["OE_SANDBOX_BACKEND"],
  },
  {
    id: "egress-control",
    title: "Egress control",
    requirement:
      "The host enforces the compiled per-session network policy: default-deny, with credentials injected at the firewall rather than handed to the sandbox.",
    consequence:
      "Unenforced, the agent reaches any host and the credential the policy would have injected at the boundary is not withheld from the sandbox. A session that resolves a host allow-list ABORTS rather than run unfirewalled, unless the deployment declares `egress.allowUnenforced`.",
    routes: {
      vercel: "The Vercel Sandbox firewall applies the fine-grained policy natively.",
      docker: "The egress-proxy sidecar (`docker-compose.yml`). `OE_EGRESS_PROXY_URL` points the deployment at it; the policy is pushed on every session.",
    },
    env: ["OE_EGRESS_PROXY_URL"],
  },
  {
    id: "model-route",
    title: "A model route",
    requirement: "The deployment can reach the Vercel AI Gateway and authenticate to it.",
    consequence: "No turn can run: every role in the model stack resolves through the gateway.",
    routes: {
      vercel: "OIDC. A deployed Vercel project authenticates to the gateway with no key to set.",
      docker: "`AI_GATEWAY_API_KEY`, or `OE_AI_GATEWAY_URL` pointed at a compatible relay.",
    },
    env: ["AI_GATEWAY_API_KEY", "OE_AI_GATEWAY_URL"],
  },
  {
    id: "secrets",
    title: "The root-of-trust secrets",
    requirement:
      "The host holds two BOOTSTRAP values in its environment: `DATABASE_URL` and `OE_CREDENTIAL_ENCRYPTION_KEY` (a base64-encoded 32-byte AES-256 key). Every credential a bundle resolves through the broker plane then lives encrypted in the store that key arms. A surface whose bundle reads its credentials from the ENVIRONMENT instead is the exception, and some shipped surfaces are: the ops plane's `quickstart` plan lists the env names for the surfaces THIS deployment carries, and each surface runbook names them. Putting such a value in the credential store instead leaves the surface silent — every inbound delivery fails verification — with a green-looking store.",
    consequence:
      "Without the key the credential store fails closed on every read and write: `secret_set`, the `oe secret` CLI and every `broker: \"db\"` credential refuse, and only `broker: \"env\"` credentials resolve.",
    routes: {
      vercel: "Project environment variables (Production). The ops tool `scaffold_credential_key` mints the key without printing it.",
      docker: "The container's environment, from whatever secret manager the host already uses.",
    },
    env: ["DATABASE_URL", "OE_CREDENTIAL_ENCRYPTION_KEY"],
  },
  {
    id: "workflow-storage",
    title: "eve's durable workflow storage",
    requirement:
      "Off Vercel, eve persists every workflow run on the LOCAL DISK of the process that serves it, under `.eve/.workflow-data` relative to the server's working directory. The host must give that path durable, single-writer storage, and must not run two servers over one copy of it.",
    consequence:
      "A run whose store is lost cannot resume: an in-flight turn is stranded. The path is not configurable in a built server — eve compiles the local world with `dataDir: resolveLocalWorkflowWorldDataDirectory(process.cwd())`, so `WORKFLOW_LOCAL_DATA_DIR` does not move it. A second server over the same directory recovers the first one's active runs.",
    routes: {
      vercel: "Vercel Workflow holds the runs. Nothing on the filesystem is durable, and nothing needs to be.",
      docker: "Mount a durable volume at the app's working directory (or at `<workdir>/.eve`), and run ONE server process against it.",
    },
  },
];

export function contractRequirement(id: string): ContractRequirement | undefined {
  return DEPLOYMENT_CONTRACT.find((r) => r.id === id);
}

export function contractDocument(): {
  readonly version: number;
  readonly routes: readonly ContractRoute[];
  readonly requirements: readonly ContractRequirement[];
} {
  return { version: CONTRACT_VERSION, routes: CONTRACT_ROUTES, requirements: DEPLOYMENT_CONTRACT };
}

export function contractJsonText(): string {
  return `${JSON.stringify(contractDocument(), null, 2)}\n`;
}

export function anchoredRequirementIds(markdown: string): string[] {
  return [...markdown.matchAll(/<a id="req-([a-z0-9-]+)"><\/a>/g)].map((m) => m[1]!);
}

export function contractProseDrift(markdown: string): { readonly missing: string[]; readonly unknown: string[] } {
  const anchored = new Set(anchoredRequirementIds(markdown));
  const known = new Set<string>(CONTRACT_REQUIREMENT_IDS);
  return {
    missing: CONTRACT_REQUIREMENT_IDS.filter((id) => !anchored.has(id)),
    unknown: [...anchored].filter((id) => !known.has(id)),
  };
}
