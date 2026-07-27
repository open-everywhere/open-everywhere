import {
  scopeIdOf,
  getConfig,
  type EventNormalizer,
  type EventScopeGrant,
  type NormalizedEvent,
  type ScopeStep,
  type TriggerDelivery,
} from "@open-everywhere/core/agent/adapter-api.js";
import { NOTION_WEBHOOK_SOURCE } from "./notion-webhook-verifier.js";
import { notionWorkspaceKey } from "./notion-identity.js";

export const NOTION_EVENT_SOURCE = NOTION_WEBHOOK_SOURCE;

export const NOTION_STRUCTURAL_PREFIXES: readonly string[] = ["page.", "database.", "data_source."];

export const NOTION_CONVERSATIONAL_PREFIXES: readonly string[] = ["comment."];

export interface NotionEventEnvelope {
  readonly id?: unknown;
  readonly timestamp?: unknown;
  readonly workspace_id?: unknown;
  readonly type?: unknown;
  readonly event_type?: unknown;
  readonly authors?: unknown;
  readonly entity?: { readonly id?: unknown; readonly type?: unknown };
  readonly data?: {
    readonly parent?: { readonly id?: unknown; readonly type?: unknown };
    readonly updated_blocks?: unknown;
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parse(body: string): NotionEventEnvelope | undefined {
  try {
    const p: unknown = JSON.parse(body);
    return p && typeof p === "object" ? (p as NotionEventEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

function eventTypeOf(ev: NotionEventEnvelope): string | undefined {
  return str(ev.type) ?? str(ev.event_type);
}

export function notionEventClass(type: string | undefined): "structural" | "conversational" | "unrecognised" {
  if (!type) return "unrecognised";
  if (NOTION_CONVERSATIONAL_PREFIXES.some((p) => type.startsWith(p))) return "conversational";
  if (NOTION_STRUCTURAL_PREFIXES.some((p) => type.startsWith(p))) return "structural";
  return "unrecognised";
}

export function notionEventDeliveryId(rawBody: string): string | undefined {
  return str(parse(rawBody)?.id);
}

export function notionScopePath(ev: NotionEventEnvelope): ScopeStep[] {
  const scope: ScopeStep[] = [];
  const workspace = str(ev.workspace_id);
  if (workspace) scope.push({ kind: "tenant", id: workspace });

  const parentId = str(ev.data?.parent?.id);
  const parentType = str(ev.data?.parent?.type);
  if (parentId && parentType) {
    if (parentType === "space") scope.push({ kind: "group", id: parentId });
    else if (parentType === "database" || parentType === "data_source" || parentType === "page" || parentType === "block") {
      scope.push({ kind: "container", id: parentId });
    }
  }

  const entityId = str(ev.entity?.id);
  const entityType = str(ev.entity?.type);
  if (entityId && (entityType === "page" || entityType === "database" || entityType === "data_source")) {
    scope.push({ kind: "entity", id: entityId });
  }

  const blocks = ev.data?.updated_blocks;
  if (Array.isArray(blocks) && blocks.length === 1) {
    const id = str((blocks[0] as { id?: unknown } | undefined)?.id);
    if (id) scope.push({ kind: "sub", id });
  }
  return scope;
}

export function liftNotionEvent(ev: NotionEventEnvelope, declaredSource: string): NormalizedEvent | null {
  const type = eventTypeOf(ev);
  if (notionEventClass(type) !== "structural") return null;
  const eventType = type as string;

  const dot = eventType.indexOf(".");
  const family = dot > 0 ? eventType.slice(0, dot) : eventType;
  const action = dot > 0 ? eventType.slice(dot + 1) : undefined;

  const scope = notionScopePath(ev);
  const workspace = scopeIdOf(scope, "tenant");
  const parent = scopeIdOf(scope, "container") ?? scopeIdOf(scope, "group");
  const entity = scopeIdOf(scope, "entity");

  const fields: Record<string, string> = { event: eventType, entity_type: family };
  if (action) fields["action"] = action;
  if (workspace) fields["workspace"] = workspace;
  if (parent) fields["parent"] = parent;
  if (entity) fields["entity"] = entity;

  const gone = action === "deleted";

  const summary = `notion ${eventType}${entity ? ` on ${entity}` : ""}${workspace ? ` (workspace ${workspace})` : ""}`;

  const authors: ReadonlyArray<{ id?: unknown }> = Array.isArray(ev.authors) ? (ev.authors as ReadonlyArray<{ id?: unknown }>) : [];
  const soleAuthor = authors.length === 1 ? str(authors[0]?.id) : undefined;
  const deliveryId = str(ev.id);
  const occurredAt = str(ev.timestamp);

  return {
    source: declaredSource,
    event: eventType,
    ...(action ? { action } : {}),
    scope,
    ...(soleAuthor ? { actor: { id: soleAuthor } } : {}),
    fields,
    ...(deliveryId ? { deliveryId } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    summary,
    ...(entity ? { pointer: { platform: "notion", id: entity, ...(gone ? { gone: true } : {}) } } : {}),
  };
}

export const notionEventNormalizer: EventNormalizer = {
  source: NOTION_EVENT_SOURCE,
  provider: "notion",
  matchKeys: ["event", "action", "entity_type", "workspace", "parent", "entity"],
  scopeKeys: ["parent", "entity"],
  scopeKinds: ["tenant", "group", "container", "entity", "sub"],
  resolvesActor: true,
  normalize(d: TriggerDelivery): NormalizedEvent | null {
    const ev = parse(d.body);
    if (!ev) return null;
    return liftNotionEvent(ev, d.source);
  },
};

export const notionEventScopeGrant: EventScopeGrant = {
  source: NOTION_EVENT_SOURCE,
  provider: "notion",
  grantsRead(scope, access) {
    const workspace = scopeIdOf(scope, "tenant");
    if (workspace === undefined) return false;
    const workspaceKey = notionWorkspaceKey(workspace);
    const cfg = getConfig();
    for (const kind of ["sub", "entity", "container", "group"] as const) {
      const id = scopeIdOf(scope, kind);
      if (id === undefined) continue;
      const owning = cfg.domainsForSurface({ workspaceKey, surface: id });
      if (owning.length === 0) continue;
      return owning.some((d) => access.domains.includes(d));
    }
    return false;
  },
};
