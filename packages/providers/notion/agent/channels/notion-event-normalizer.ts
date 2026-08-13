import {
  scopeIdOf,
  getConfig,
  domainCredentialId,
  type Domain,
  type EventNormalizer,
  type EventScopeGrant,
  type NormalizedEvent,
  type ScopeStep,
  type TriggerDelivery,
} from "@open-everywhere/core/agent/adapter-api.js";
import { NOTION_WEBHOOK_SOURCE } from "./notion-webhook-verifier.js";
import { notionWorkspaceKey } from "./notion-identity.js";
import { NOTION_CHANNEL_CREDENTIAL, NOTION_PROVIDER, notionIntegrations } from "./notion-credentials.js";

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

export const NOTION_GRANT_STEPS = ["sub", "entity", "container", "group"] as const;

export const notionEventScopeGrant: EventScopeGrant = {
  source: NOTION_EVENT_SOURCE,
  provider: "notion",
  grantsRead(scope, access) {
    const workspace = scopeIdOf(scope, "tenant");
    if (workspace === undefined) return false;
    const workspaceKey = notionWorkspaceKey(workspace);
    const cfg = getConfig();
    for (const kind of NOTION_GRANT_STEPS) {
      const id = scopeIdOf(scope, kind);
      if (id === undefined) continue;
      const owning = cfg.domainsForSurface({ workspaceKey, surface: id });
      if (owning.length === 0) continue;
      return owning.some((d) => access.domains.includes(d));
    }
    return false;
  },
};

function quote(id: string | undefined): string {
  if (id === undefined) return '"(none)"';
  return JSON.stringify(id.slice(0, 64).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "?"));
}

export type NotionTriggerScopeVerdict =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

export function notionTriggerScopeVerdict(
  rawBody: string,
  signerCredentialId: string | undefined,
  domains: readonly Domain[],
  resolveSurface: (p: { workspaceKey: string; surface: string }) => readonly string[] = (p) => getConfig().domainsForSurface(p),
): NotionTriggerScopeVerdict {
  const ev = parse(rawBody);
  if (!ev) return { ok: false, reason: "the delivery body did not parse" };

  if (notionEventClass(eventTypeOf(ev)) !== "structural") return { ok: true, detail: "not a structural event" };

  if (!signerCredentialId) return { ok: false, reason: "no integration's secret identified this delivery" };

  const scope = notionScopePath(ev);
  const workspace = scopeIdOf(scope, "tenant");
  if (workspace === undefined) return { ok: false, reason: "the delivery names no workspace" };
  const workspaceKey = notionWorkspaceKey(workspace);

  const integrations = notionIntegrations(domains);
  const secretOf = (credentialId: string): string | undefined => integrations.find((i) => i.credentialId === credentialId)?.inboundSecret;
  const signerSecret = secretOf(signerCredentialId);

  for (const kind of NOTION_GRANT_STEPS) {
    const id = scopeIdOf(scope, kind);
    if (id === undefined) continue;
    const owning = resolveSurface({ workspaceKey, surface: id });
    if (owning.length === 0) continue;

    let viaSharedSecret = false;
    for (const name of owning) {
      const owner = domains.find((d) => d.name === name);
      if (!owner) {
        return { ok: false, reason: `${kind} ${quote(id)} resolved to domain ${quote(name)}, which this registry does not hold` };
      }
      const expected = domainCredentialId(owner, NOTION_PROVIDER, NOTION_CHANNEL_CREDENTIAL);
      if (expected === signerCredentialId) continue;
      if (signerSecret !== undefined && secretOf(expected) === signerSecret) {
        viaSharedSecret = true;
        continue;
      }
      return {
        ok: false,
        reason:
          `${kind} ${quote(id)} belongs to domain ${quote(name)}, which is served by notion credential ${quote(expected)} — ` +
          `this delivery was signed by ${quote(signerCredentialId)}. A signed body cannot arm another domain's routines.`,
      };
    }
    return {
      ok: true,
      detail: viaSharedSecret
        ? `${kind} ${quote(id)} is served by an integration that shares this deployment's inbound secret`
        : `${kind} ${quote(id)} is served by ${quote(signerCredentialId)}`,
    };
  }
  return { ok: false, reason: "no step of the claimed path is a surface the deployer put in any domain" };
}
