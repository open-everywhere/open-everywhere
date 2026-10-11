import { assertEgressReach, assertSafeFetchUrl } from "../access/host-egress.js";
import { hostCallAuditFields } from "../access/egress.js";
import { getSecretVia } from "../access/credentials.js";
import { auditToolAction } from "../audit/tool-action.js";
import type { BindableContext } from "../identity/binding.js";
import { a2aAgentHost, type A2aAgentDeclaration } from "./agents.js";

export interface A2aFetchDeps {
  readonly reach?: typeof assertEgressReach;
  readonly dispatch?: typeof assertSafeFetchUrl;
  readonly secret?: typeof getSecretVia;
  readonly audit?: typeof auditToolAction;
  readonly fetch?: typeof fetch;
}

const DEFAULT_TOKEN_BROKER = "db";

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function a2aGuardedFetch(ctx: BindableContext, agent: A2aAgentDeclaration, tool: string, deps: A2aFetchDeps = {}): typeof fetch {
  const host = a2aAgentHost(agent);
  const origin = new URL(agent.cardUrl).origin;
  const reach = deps.reach ?? assertEgressReach;
  const dispatchFor = deps.dispatch ?? assertSafeFetchUrl;
  const audit = deps.audit ?? auditToolAction;
  const send = deps.fetch ?? fetch;
  let token: Promise<string> | undefined;
  const authHeader = async (): Promise<string | undefined> => {
    if (agent.auth === undefined) return undefined;
    token ??= (deps.secret ?? getSecretVia)(agent.auth.broker ?? DEFAULT_TOKEN_BROKER, agent.auth.secretRef);
    return `Bearer ${await token}`;
  };
  return async (input, init) => {
    const raw = urlOf(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const parsed = new URL(raw);
    if (parsed.origin !== origin) {
      await audit(ctx, "egress.hostside.deny", {
        ...hostCallAuditFields({ host: parsed.hostname, verb: method, outcome: "denied" }),
        reason: "a2a-origin-pin",
        tool,
        agent: agent.name,
      });
      throw new Error(`${tool}: agent "${agent.name}" may reach only ${origin}, and this request named ${parsed.origin}. The request was refused before it was made.`);
    }
    const url = await reach(ctx, raw, { tool, hosts: () => [{ host, viaConnection: null }], rowFields: { agent: agent.name } });
    let dispatch: Awaited<ReturnType<typeof assertSafeFetchUrl>>;
    try {
      dispatch = await dispatchFor(url.href, tool);
    } catch (err) {
      await audit(ctx, "egress.hostside.deny", {
        ...hostCallAuditFields({ host, verb: method, outcome: "denied" }),
        reason: "ssrf-guard",
        tool,
        agent: agent.name,
      });
      throw err;
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const authorization = await authHeader();
    if (authorization !== undefined) headers.set("authorization", authorization);
    const body = init?.body ?? (input instanceof Request && method !== "GET" ? await input.text() : undefined);
    let response: Response;
    try {
      response = await send(dispatch.url, {
        method,
        headers,
        ...(body !== undefined && body !== null ? { body } : {}),
        redirect: "error",
        ...(init?.signal ? { signal: init.signal } : {}),
        dispatcher: dispatch.dispatcher,
      } as RequestInit);
    } catch (err) {
      await audit(ctx, "egress.hostside.allow", {
        ...hostCallAuditFields({ host, verb: method, outcome: "failed", credential: agent.auth === undefined ? null : agent.auth.secretRef }),
        tool,
        agent: agent.name,
        route: dispatch.via,
        antiRebind: dispatch.antiRebind,
      });
      throw err;
    }
    await audit(ctx, "egress.hostside.allow", {
      ...hostCallAuditFields({ host, verb: method, outcome: "allowed", credential: agent.auth === undefined ? null : agent.auth.secretRef }),
      tool,
      agent: agent.name,
      route: dispatch.via,
      antiRebind: dispatch.antiRebind,
      status: response.status,
    });
    return response;
  };
}
