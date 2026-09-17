import { gateNotionDeliveryAcross, parseVerificationHandshake, type NotionSigningKey } from "./notion-api.js";

export const NOTION_INGRESS_SOURCE = "notion";
const NOTION_INGRESS_SCHEMA_VERSION = 1 as const;
export const NOTION_INGRESS_MAX_BODY_BYTES = 256 * 1024;

export interface ProjectedNotionEvent {
  readonly id: string;
  readonly timestamp?: string;
  readonly type?: string;
  readonly event_type?: string;
  readonly workspace_id?: string;
  readonly entity?: { readonly id?: string; readonly type?: string };
  readonly data?: {
    readonly page_id?: string;
    readonly parent?: { readonly id?: string; readonly type?: string };
    readonly updated_blocks?: readonly { readonly id?: string }[];
  };
  readonly authors?: readonly { readonly id?: string; readonly type?: string }[];
}

export interface NotionIngressPayload {
  readonly schemaVersion: typeof NOTION_INGRESS_SCHEMA_VERSION;
  readonly event: ProjectedNotionEvent;
}

export interface NotionIngressKey {
  readonly source: typeof NOTION_INGRESS_SOURCE;
  readonly authorityId: string;
  readonly deliveryId: string;
}

export interface NotionIngressWrite extends NotionIngressKey {
  readonly payloadJson: string;
  readonly receivedAt: string;
}

export interface AcknowledgeNotionIngressDeps {
  readonly org: string;
  readonly signingKeys: readonly NotionSigningKey[];
  readonly allowUnverified: boolean;
  readonly enqueue: (org: string, write: NotionIngressWrite) => Promise<boolean>;
  readonly drainAvailable: boolean;
  readonly drain: (key: NotionIngressKey) => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now?: () => Date;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function projectNotionIngressEvent(value: unknown): ProjectedNotionEvent | undefined {
  const input = record(value);
  const id = text(input?.id);
  if (!input || !id) return undefined;

  const entityIn = record(input.entity);
  const entityId = text(entityIn?.id);
  const entityType = text(entityIn?.type);
  const entity = entityIn ? { ...(entityId ? { id: entityId } : {}), ...(entityType ? { type: entityType } : {}) } : undefined;

  const dataIn = record(input.data);
  const parentIn = record(dataIn?.parent);
  const parentId = text(parentIn?.id);
  const parentType = text(parentIn?.type);
  const parent = parentIn ? { ...(parentId ? { id: parentId } : {}), ...(parentType ? { type: parentType } : {}) } : undefined;
  const updatedBlocks = Array.isArray(dataIn?.updated_blocks)
    ? dataIn.updated_blocks.map((item) => {
        const id = text(record(item)?.id);
        return id ? { id } : {};
      })
    : undefined;
  const pageId = text(dataIn?.page_id);
  const data = dataIn
    ? {
        ...(pageId ? { page_id: pageId } : {}),
        ...(parent ? { parent } : {}),
        ...(updatedBlocks ? { updated_blocks: updatedBlocks } : {}),
      }
    : undefined;

  const authors = Array.isArray(input.authors)
    ? input.authors.map((item) => {
        const author = record(item);
        const authorId = text(author?.id);
        const authorType = text(author?.type);
        return { ...(authorId ? { id: authorId } : {}), ...(authorType ? { type: authorType } : {}) };
      })
    : undefined;

  return {
    id,
    ...(text(input.timestamp) ? { timestamp: text(input.timestamp) } : {}),
    ...(text(input.type) ? { type: text(input.type) } : {}),
    ...(text(input.event_type) ? { event_type: text(input.event_type) } : {}),
    ...(text(input.workspace_id) ? { workspace_id: text(input.workspace_id) } : {}),
    ...(entity ? { entity } : {}),
    ...(data ? { data } : {}),
    ...(authors ? { authors } : {}),
  };
}

export function decodeNotionIngressPayload(payloadJson: string): NotionIngressPayload | undefined {
  try {
    const parsed = record(JSON.parse(payloadJson));
    if (parsed?.schemaVersion !== NOTION_INGRESS_SCHEMA_VERSION) return undefined;
    const event = projectNotionIngressEvent(parsed.event);
    return event ? { schemaVersion: NOTION_INGRESS_SCHEMA_VERSION, event } : undefined;
  } catch {
    return undefined;
  }
}

function synchronousResponse(): Response {
  return new Response("synchronous", { status: 409, headers: { "x-oe-notion-ingress": "synchronous" } });
}

export async function acknowledgeNotionIngress(
  rawBody: string,
  signatureHeader: string | null,
  deps: AcknowledgeNotionIngressDeps,
): Promise<Response> {
  if (Buffer.byteLength(rawBody, "utf8") > NOTION_INGRESS_MAX_BODY_BYTES) {
    return new Response("payload too large", { status: 413 });
  }
  if (parseVerificationHandshake(rawBody)) return synchronousResponse();

  const gate = gateNotionDeliveryAcross(deps.signingKeys, rawBody, signatureHeader, deps.allowUnverified);
  if (gate.rejection) return new Response(gate.rejection, { status: 401 });
  if (!gate.verified || !gate.credentialId) return synchronousResponse();
  if (!deps.drainAvailable) return new Response("durable ingress drain unavailable", { status: 503 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const event = projectNotionIngressEvent(parsed);
  if (!event) return new Response("missing event id", { status: 400 });

  const key: NotionIngressKey = {
    source: NOTION_INGRESS_SOURCE,
    authorityId: gate.credentialId,
    deliveryId: event.id,
  };
  const write: NotionIngressWrite = {
    ...key,
    payloadJson: JSON.stringify({ schemaVersion: NOTION_INGRESS_SCHEMA_VERSION, event } satisfies NotionIngressPayload),
    receivedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  try {
    await deps.enqueue(deps.org, write);
  } catch {
    return new Response("durable ingress unavailable", { status: 503 });
  }

  const drain = Promise.resolve().then(() => deps.drain(key));
  deps.waitUntil(drain);
  return new Response("ok", { status: 200 });
}
