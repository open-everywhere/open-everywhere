import { processRegistrySlot } from "../lib/process-registry.js";

export interface A2aAgentAuth {
  readonly scheme: "bearer";
  readonly secretRef: string;
  readonly broker?: string;
}

export interface A2aAgentDeclaration {
  readonly name: string;
  readonly cardUrl: string;
  readonly description: string;
  readonly auth?: A2aAgentAuth;
  readonly domains?: readonly string[];
}

const A2A_AGENT_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

function declarationProblems(a: A2aAgentDeclaration, where: string): string[] {
  const bad: string[] = [];
  if (typeof a.name !== "string" || !A2A_AGENT_NAME.test(a.name)) {
    bad.push(`${where}: name must match ${A2A_AGENT_NAME} (lowercase, a letter first).`);
  }
  let url: URL | undefined;
  try {
    url = new URL(a.cardUrl);
  } catch {
    bad.push(`${where}: cardUrl "${String(a.cardUrl)}" is not a URL.`);
  }
  if (url !== undefined) {
    if (url.protocol !== "https:") bad.push(`${where}: cardUrl must be https — a delegated task and its token never travel in clear text.`);
    if (url.username !== "" || url.password !== "") bad.push(`${where}: cardUrl carries a user-info part — a credential in a URL is a secret in Git. Use auth.`);
    if (url.search !== "") bad.push(`${where}: cardUrl carries a query string — a token in a URL is a secret in Git. Use auth.`);
    if (url.hash !== "") bad.push(`${where}: cardUrl carries a fragment.`);
  }
  if (typeof a.description !== "string" || a.description.trim() === "") {
    bad.push(`${where}: description is empty — the model reads it to decide when to delegate to this agent.`);
  }
  const auth = a.auth as (A2aAgentAuth & { token?: unknown; secret?: unknown; value?: unknown }) | undefined;
  if (auth !== undefined) {
    for (const literal of ["token", "secret", "value"] as const) {
      if (literal in auth) bad.push(`${where}: auth carries a literal "${literal}" — name the token's credential-store REF in auth.secretRef instead.`);
    }
    if (auth.scheme !== "bearer") bad.push(`${where}: auth.scheme "${String(auth.scheme)}" is not a supported scheme (bearer).`);
    if (typeof auth.secretRef !== "string" || auth.secretRef.trim() === "") {
      bad.push(`${where}: auth.secretRef is empty — name the REF of the token, never the value.`);
    }
    if (auth.broker !== undefined && (typeof auth.broker !== "string" || auth.broker.trim() === "")) {
      bad.push(`${where}: auth.broker is empty — omit it for the default "db" broker.`);
    }
  }
  if (a.domains !== undefined) {
    const domains = a.domains as unknown;
    if (!Array.isArray(domains) || domains.length === 0 || domains.some((d) => typeof d !== "string" || d.trim() === "")) {
      bad.push(`${where}: domains must name at least one memory domain. Omit domains to let every internal room use the agent.`);
    }
  }
  return bad;
}

export function defineA2aAgents(agents: readonly A2aAgentDeclaration[]): readonly A2aAgentDeclaration[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  agents.forEach((a, i) => {
    const where = `A2A agent ${typeof a?.name === "string" ? `"${a.name}"` : `#${i}`}`;
    bad.push(...declarationProblems(a, where));
    if (seen.has(a.name)) bad.push(`${where}: declared twice — one name is one agent.`);
    seen.add(a.name);
  });
  if (bad.length > 0) {
    throw new Error(`agent/access/a2a-agents.ts is not valid:\n  ${bad.join("\n  ")}`);
  }
  return Object.freeze(
    agents.map((a) =>
      Object.freeze({
        ...a,
        ...(a.auth !== undefined ? { auth: Object.freeze({ ...a.auth }) } : {}),
        ...(a.domains !== undefined ? { domains: Object.freeze([...a.domains]) } : {}),
      }),
    ),
  );
}

export function a2aAgentHost(agent: Pick<A2aAgentDeclaration, "cardUrl">): string {
  return new URL(agent.cardUrl).hostname.toLowerCase();
}

const REGISTRY = processRegistrySlot<readonly A2aAgentDeclaration[]>("a2a-agents.v1");

export function registerA2aAgents(agents: readonly A2aAgentDeclaration[]): void {
  REGISTRY.set(defineA2aAgents(agents));
}

export function findA2aAgent(name: string): A2aAgentDeclaration | undefined {
  const wanted = name.trim().toLowerCase();
  return (REGISTRY.get() ?? []).find((a) => a.name === wanted);
}

export function undeclaredA2aAgentRefusal(name: string): string {
  const names = (REGISTRY.get() ?? []).map((a) => a.name);
  return (
    `No A2A agent called "${name}" is declared in this deployment. ` +
    (names.length > 0
      ? `The declared agents are: ${names.join(", ")}. `
      : "This deployment declares no A2A agents. ") +
    "An agent is added only by a pull request to agent/access/a2a-agents.ts — nobody can add one from chat."
  );
}
