import { createHmac, randomUUID } from "node:crypto";

import {
  getOrMintSelfSecret,
  readCappedBody,
  selfDispatchBaseUrl,
  selfSecretsArmed,
  verifyWebhookSignature,
  type ClaimedIngressDelivery,
  type IngressDeliveryKey,
  type OperationalStore,
} from "@open-everywhere/core/agent/adapter-api.js";

import { decodeNotionIngressPayload, NOTION_INGRESS_SOURCE, type NotionIngressKey } from "./notion-ingress.js";

export const NOTION_INGRESS_DRAIN_PATH = "/eve/v1/notion/drain";
export const NOTION_INGRESS_DRAIN_SIGNATURE_HEADER = "x-oe-notion-drain-signature";
const NOTION_INGRESS_DRAIN_SECRET_ENV = "OE_NOTION_INGRESS_DRAIN_SECRET";
export const NOTION_COMMENT_DISPATCH_SOURCE = "notion-comment-dispatch";
export const NOTION_COMMENT_DISPATCH_AUTHORITY = "notion";
const NOTION_INGRESS_LEASE_MS = 5 * 60_000;
const NOTION_INGRESS_RETRY_MS = NOTION_INGRESS_LEASE_MS + 1_000;
const NOTION_INGRESS_TOMBSTONE_MS = 24 * 60 * 60_000;
const NOTION_COMMENT_DISPATCH_TOMBSTONE_MS = 10 * 60_000;
const NOTION_INGRESS_DRAIN_MAX_BODY_BYTES = 16 * 1024;
const NOTION_INGRESS_DRAIN_MAX_SKEW_MS = 5 * 60_000;
const NOTION_INGRESS_DRAIN_BATCH = 25;

interface DrainEnvelope {
  readonly authorityId: string;
  readonly deliveryId: string;
  readonly issuedAt: number;
}

export interface NotionIngressDrainKey extends NotionIngressKey {}

export interface AcceptedNotionIngressDrain {
  readonly key: NotionIngressDrainKey;
  readonly claim: ClaimedIngressDelivery;
  readonly rawBody: string;
  readonly signerCredentialId: string;
}

export type NotionIngressDisposition = "complete" | "discard" | "retry";

export interface NotionCommentDispatchGuard {
  readonly claim: (commentId: string) => Promise<boolean>;
  readonly complete: (commentId: string) => Promise<void>;
}

export interface AcceptNotionIngressDrainDeps {
  readonly org: string;
  readonly store: OperationalStore;
  readonly secret?: string;
  readonly now?: () => Date;
  readonly claimId?: () => string;
}

function nonEmpty(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function parseEnvelope(value: unknown): DrainEnvelope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const authorityId = nonEmpty(row.authorityId);
  const deliveryId = nonEmpty(row.deliveryId);
  const issuedAt = row.issuedAt;
  if (!authorityId || !deliveryId || typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) return undefined;
  return { authorityId, deliveryId, issuedAt };
}

export function signNotionIngressDrainBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

async function drainSecret(injected?: string): Promise<string | undefined> {
  if (injected !== undefined) return injected;
  if (!selfSecretsArmed()) return undefined;
  return getOrMintSelfSecret(NOTION_INGRESS_DRAIN_SECRET_ENV);
}

export function notionIngressDrainAvailable(): boolean {
  return selfSecretsArmed() && selfDispatchBaseUrl() !== undefined;
}

export async function acceptNotionIngressDrainRequest(
  req: Request,
  deps: AcceptNotionIngressDrainDeps,
): Promise<{ readonly accepted: AcceptedNotionIngressDrain } | { readonly response: Response }> {
  const read = await readCappedBody(req, NOTION_INGRESS_DRAIN_MAX_BODY_BYTES);
  if ("tooLarge" in read) return { response: new Response("payload too large", { status: 413 }) };
  const secret = await drainSecret(deps.secret);
  if (!secret) return { response: new Response("not found", { status: 404 }) };
  if (!verifyWebhookSignature(secret, read.body, req.headers.get(NOTION_INGRESS_DRAIN_SIGNATURE_HEADER))) {
    return { response: new Response("unauthorized", { status: 401 }) };
  }
  let envelope: DrainEnvelope | undefined;
  try {
    envelope = parseEnvelope(JSON.parse(read.body));
  } catch {
  }
  if (!envelope) return { response: new Response("bad request", { status: 400 }) };
  const now = (deps.now ?? (() => new Date()))();
  if (Math.abs(now.getTime() - envelope.issuedAt) > NOTION_INGRESS_DRAIN_MAX_SKEW_MS) {
    return { response: new Response("unauthorized", { status: 401 }) };
  }
  const key: NotionIngressDrainKey = {
    source: NOTION_INGRESS_SOURCE,
    authorityId: envelope.authorityId,
    deliveryId: envelope.deliveryId,
  };
  const staleBefore = new Date(now.getTime() - NOTION_INGRESS_LEASE_MS).toISOString();
  const claim = await deps.store.claimIngressDelivery(
    deps.org,
    key,
    (deps.claimId ?? randomUUID)(),
    now.toISOString(),
    staleBefore,
  );
  if (!claim) return { response: new Response("ok", { status: 200 }) };
  const payload = decodeNotionIngressPayload(claim.payloadJson);
  if (!payload) {
    await deps.store.releaseIngressDelivery(
      deps.org,
      key,
      claim.claimId,
      new Date(now.getTime() + NOTION_INGRESS_RETRY_MS).toISOString(),
    );
    return { response: new Response("stored payload invalid", { status: 500 }) };
  }
  return {
    accepted: {
      key,
      claim,
      rawBody: JSON.stringify(payload.event),
      signerCredentialId: key.authorityId,
    },
  };
}

export async function settleNotionIngressDrain(
  accepted: AcceptedNotionIngressDrain,
  disposition: NotionIngressDisposition,
  deps: Pick<AcceptNotionIngressDrainDeps, "org" | "store" | "now">,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  if (disposition === "discard") {
    await deps.store.discardIngressDelivery(deps.org, accepted.key, accepted.claim.claimId);
    return;
  }
  if (disposition === "retry") {
    await deps.store.releaseIngressDelivery(
      deps.org,
      accepted.key,
      accepted.claim.claimId,
      new Date(now.getTime() + NOTION_INGRESS_RETRY_MS).toISOString(),
    );
    return;
  }
  await deps.store.completeIngressDelivery(
    deps.org,
    accepted.key,
    accepted.claim.claimId,
    now.toISOString(),
    new Date(now.getTime() + NOTION_INGRESS_TOMBSTONE_MS).toISOString(),
  );
}

export function createNotionCommentDispatchGuard(input: {
  readonly org: string;
  readonly store: OperationalStore;
  readonly now?: () => Date;
  readonly claimId?: () => string;
}): NotionCommentDispatchGuard {
  let held: { key: IngressDeliveryKey; claimId: string } | undefined;
  return {
    async claim(commentId) {
      const now = (input.now ?? (() => new Date()))();
      const key: IngressDeliveryKey = {
        source: NOTION_COMMENT_DISPATCH_SOURCE,
        authorityId: NOTION_COMMENT_DISPATCH_AUTHORITY,
        deliveryId: commentId,
      };
      await input.store.enqueueIngressDelivery(input.org, {
        ...key,
        payloadJson: JSON.stringify({ schemaVersion: 1 }),
        receivedAt: now.toISOString(),
      });
      const claim = await input.store.claimIngressDelivery(
        input.org,
        key,
        (input.claimId ?? randomUUID)(),
        now.toISOString(),
        new Date(now.getTime() - NOTION_INGRESS_LEASE_MS).toISOString(),
      );
      if (!claim) return false;
      held = { key, claimId: claim.claimId };
      return true;
    },
    async complete(commentId) {
      if (!held || held.key.deliveryId !== commentId) throw new Error("Notion dispatch guard was not claimed");
      const now = (input.now ?? (() => new Date()))();
      const completed = await input.store.completeIngressDelivery(
        input.org,
        held.key,
        held.claimId,
        now.toISOString(),
        new Date(now.getTime() + NOTION_COMMENT_DISPATCH_TOMBSTONE_MS).toISOString(),
      );
      if (!completed) throw new Error("Notion dispatch guard completion lost its lease");
      held = undefined;
    },
  };
}

export interface PostNotionIngressDrainDeps {
  readonly secret?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export async function postNotionIngressDrain(
  key: NotionIngressDrainKey,
  deps: PostNotionIngressDrainDeps = {},
): Promise<void> {
  const base = deps.baseUrl ?? selfDispatchBaseUrl();
  const secret = await drainSecret(deps.secret);
  if (!base || !secret) throw new Error("Notion ingress drain is unavailable");
  const body = JSON.stringify({
    authorityId: key.authorityId,
    deliveryId: key.deliveryId,
    issuedAt: (deps.now ?? (() => new Date()))().getTime(),
  } satisfies DrainEnvelope);
  const response = await (deps.fetchImpl ?? fetch)(`${base}${NOTION_INGRESS_DRAIN_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [NOTION_INGRESS_DRAIN_SIGNATURE_HEADER]: signNotionIngressDrainBody(secret, body),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Notion ingress drain returned ${response.status}`);
}

export async function recoverNotionIngress(
  org: string,
  store: OperationalStore,
  deps: PostNotionIngressDrainDeps & { readonly now?: () => Date } = {},
): Promise<{ readonly due: number; readonly posted: number; readonly failed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await store.listDueIngressDeliveries(
    org,
    NOTION_INGRESS_SOURCE,
    now.toISOString(),
    new Date(now.getTime() - NOTION_INGRESS_LEASE_MS).toISOString(),
    NOTION_INGRESS_DRAIN_BATCH,
  );
  const results = await Promise.allSettled(due.map((key) => postNotionIngressDrain({
    source: NOTION_INGRESS_SOURCE,
    authorityId: key.authorityId,
    deliveryId: key.deliveryId,
  }, deps)));
  const posted = results.filter((result) => result.status === "fulfilled").length;
  return { due: due.length, posted, failed: due.length - posted };
}
