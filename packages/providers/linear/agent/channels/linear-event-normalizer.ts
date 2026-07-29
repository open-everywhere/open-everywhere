import {
  scopeIdOf,
  getConfig,
  type EventNormalizer,
  type EventScopeGrant,
  type NormalizedEvent,
  type ScopeStep,
  type TriggerDelivery,
} from "@open-everywhere/core/agent/adapter-api.js";

export const LINEAR_EVENT_SOURCE = "linear";

export const LINEAR_DELIVERY_ID_HEADER = "linear-delivery";

export const LINEAR_WORK_TYPES: readonly string[] = ["Issue"];

export const LINEAR_CONVERSATIONAL_TYPES: readonly string[] = ["Comment"];

export const LINEAR_AGENT_SESSION_TYPE = "AgentSessionEvent";

export interface LinearEventEnvelope {
  readonly action?: unknown;
  readonly type?: unknown;
  readonly createdAt?: unknown;
  readonly organizationId?: unknown;
  readonly webhookTimestamp?: unknown;
  readonly url?: unknown;
  readonly actor?: unknown;
  readonly agentSession?: unknown;
  readonly data?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function pick(o: unknown, k: string): unknown {
  return obj(o)?.[k];
}

function parse(body: string): LinearEventEnvelope | undefined {
  try {
    const p: unknown = JSON.parse(body);
    return obj(p) as LinearEventEnvelope | undefined;
  } catch {
    return undefined;
  }
}

function linearWorkspaceKey(organizationId: string): string {
  return `linear/${organizationId}`;
}

export function linearEventClass(ev: LinearEventEnvelope): "work" | "conversational" | "agent-session" | "unrecognised" {
  if (ev.agentSession !== undefined && ev.agentSession !== null) return "agent-session";
  const type = str(ev.type);
  if (!type) return "unrecognised";
  if (type === LINEAR_AGENT_SESSION_TYPE) return "agent-session";
  if (LINEAR_CONVERSATIONAL_TYPES.includes(type)) return "conversational";
  if (LINEAR_WORK_TYPES.includes(type)) return "work";
  return "unrecognised";
}

export function linearTeamId(ev: LinearEventEnvelope): string | undefined {
  const data = ev.data;
  return (
    str(pick(data, "teamId")) ??
    str(pick(pick(data, "team"), "id")) ??
    str(pick(pick(data, "issue"), "teamId")) ??
    str(pick(pick(pick(data, "issue"), "team"), "id"))
  );
}

function linearProjectId(ev: LinearEventEnvelope): string | undefined {
  return str(pick(ev.data, "projectId")) ?? str(pick(pick(ev.data, "project"), "id"));
}

export function linearScopePath(ev: LinearEventEnvelope): ScopeStep[] {
  const scope: ScopeStep[] = [];
  const org = str(ev.organizationId);
  if (org) scope.push({ kind: "tenant", id: org });

  const team = linearTeamId(ev);
  if (team) scope.push({ kind: "group", id: team });

  const project = linearProjectId(ev);
  if (project) scope.push({ kind: "container", id: project });

  const entity = str(pick(ev.data, "id"));
  if (entity) scope.push({ kind: "entity", id: entity });

  return scope;
}

export function liftLinearEvent(ev: LinearEventEnvelope, declaredSource: string): NormalizedEvent | null {
  if (linearEventClass(ev) !== "work") return null;
  const type = str(ev.type)!;
  const action = str(ev.action);

  const scope = linearScopePath(ev);
  const org = scopeIdOf(scope, "tenant");
  const team = scopeIdOf(scope, "group");
  const project = scopeIdOf(scope, "container");
  const issue = scopeIdOf(scope, "entity");

  const fields: Record<string, string> = { event: type };
  if (action) fields["action"] = action;
  if (org) fields["organization"] = org;
  if (team) fields["team"] = team;
  if (project) fields["project"] = project;
  if (issue) fields["issue"] = issue;
  const identifier = str(pick(ev.data, "identifier"));
  if (identifier) fields["identifier"] = identifier;
  const title = str(pick(ev.data, "title"));
  if (title) fields["title"] = title;
  const url = str(ev.url);
  if (url) fields["url"] = url;

  const gone = action === "remove";

  const summary = `linear ${type}${action ? ` ${action}` : ""}${identifier ? ` ${identifier}` : issue ? ` ${issue}` : ""}${team ? ` (team ${team})` : ""}`;

  const actorId = str(pick(ev.actor, "id"));
  const actorHandle = str(pick(ev.actor, "name")) ?? str(pick(ev.actor, "displayName"));
  const occurredAt = str(ev.createdAt);

  return {
    source: declaredSource,
    event: type,
    ...(action ? { action } : {}),
    scope,
    ...(actorId || actorHandle ? { actor: { ...(actorId ? { id: actorId } : {}), ...(actorHandle ? { handle: actorHandle } : {}) } } : {}),
    fields,
    ...(occurredAt ? { occurredAt } : {}),
    summary,
    ...(issue ? { pointer: { platform: "linear", id: issue, ...(gone ? { gone: true } : {}) } } : {}),
  };
}

export const linearEventNormalizer: EventNormalizer = {
  source: LINEAR_EVENT_SOURCE,
  provider: "linear",
  matchKeys: ["event", "action", "organization", "team", "project", "issue"],
  scopeKeys: ["team", "project", "issue"],
  scopeKinds: ["tenant", "group", "container", "entity"],
  resolvesActor: true,
  deliveryIdHeader: LINEAR_DELIVERY_ID_HEADER,
  normalize(d: TriggerDelivery): NormalizedEvent | null {
    const ev = parse(d.body);
    if (!ev) return null;
    return liftLinearEvent(ev, d.source);
  },
};

export const linearEventScopeGrant: EventScopeGrant = {
  source: LINEAR_EVENT_SOURCE,
  provider: "linear",
  grantsRead(scope, access) {
    const org = scopeIdOf(scope, "tenant");
    const team = scopeIdOf(scope, "group");
    if (org === undefined || team === undefined) return false;
    const owning = getConfig().domainsForSurface({ workspaceKey: linearWorkspaceKey(org), surface: team });
    if (owning.length === 0) return false;
    return owning.some((d) => access.domains.includes(d));
  },
};
