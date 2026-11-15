import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  NOTION_INGRESS_SOURCE,
  acknowledgeNotionIngress,
  decodeNotionIngressPayload,
  type NotionIngressKey,
  type NotionIngressWrite,
} from "../agent/channels/notion-ingress.js";

let passed = 0;
const ok = (value: unknown, label: string): void => {
  assert.ok(value, label);
  passed++;
};
const eq = (actual: unknown, expected: unknown, label: string): void => {
  assert.deepEqual(actual, expected, label);
  passed++;
};

const SECRET_A = "notion-signing-a";
const SECRET_B = "notion-signing-b";
const SIGNERS = [
  { credentialId: "integration-a", secret: SECRET_A },
  { credentialId: "integration-b", secret: SECRET_B },
] as const;

function sign(body: string, secret = SECRET_A): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function commentEvent(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt-comment-1",
    timestamp: "2026-09-17T09:00:00.000Z",
    type: "comment.created",
    workspace_id: "ws-1",
    entity: { id: "comment-1", type: "comment", attacker_extra: "drop-me" },
    data: { page_id: "page-1", parent: { id: "page-1", type: "page", extra: "drop-me" } },
    authors: [{ id: "person-1", type: "person", display_name: "drop-me" }],
    workspace_name: "member-authored and not needed by processing",
    unexpected_secret_shaped_field: "drop-me",
    ...extra,
  });
}

interface Harness {
  readonly writes: NotionIngressWrite[];
  readonly drains: NotionIngressKey[];
  readonly waited: Promise<unknown>[];
  readonly acknowledge: (body: string, signature: string | null) => Promise<Response>;
}

function harness(overrides: {
  enqueue?: (org: string, write: NotionIngressWrite) => Promise<boolean>;
  drain?: (key: NotionIngressKey) => Promise<void>;
  allowUnverified?: boolean;
  signingKeys?: typeof SIGNERS | readonly [];
  drainAvailable?: boolean;
} = {}): Harness {
  const writes: NotionIngressWrite[] = [];
  const drains: NotionIngressKey[] = [];
  const waited: Promise<unknown>[] = [];
  const enqueue = overrides.enqueue ?? (async (_org: string, write: NotionIngressWrite) => {
    writes.push(write);
    return true;
  });
  const drain = overrides.drain ?? (async (key: NotionIngressKey) => {
    drains.push(key);
  });
  return {
    writes,
    drains,
    waited,
    acknowledge: (body, signature) =>
      acknowledgeNotionIngress(body, signature, {
        org: "org-1",
        signingKeys: overrides.signingKeys ?? SIGNERS,
        allowUnverified: overrides.allowUnverified ?? false,
        drainAvailable: overrides.drainAvailable ?? true,
        enqueue,
        drain,
        waitUntil(promise) {
          waited.push(promise);
        },
      }),
  };
}

{
  const h = harness({ drainAvailable: false });
  const raw = commentEvent();
  const response = await h.acknowledge(raw, sign(raw));
  eq(response.status, 503, "unavailable durable drain refuses public acceptance");
  eq(h.writes.length, 0, "unavailable durable drain commits no stranded row");
}

{
  let releaseCommit!: () => void;
  let releaseDrain!: () => void;
  let commitStarted = false;
  let drainStarted = false;
  const commitBarrier = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const drainBarrier = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const writes: NotionIngressWrite[] = [];
  const h = harness({
    enqueue: async (_org, write) => {
      writes.push(write);
      commitStarted = true;
      await commitBarrier;
      return true;
    },
    drain: async (key) => {
      h.drains.push(key);
      drainStarted = true;
      await drainBarrier;
    },
  });
  const raw = commentEvent();
  let ackSettled = false;
  const ack = h.acknowledge(raw, sign(raw)).then((response) => {
    ackSettled = true;
    return response;
  });
  await Promise.resolve();
  ok(commitStarted && !ackSettled, "verified delivery does not acknowledge before durable enqueue commits");
  releaseCommit();
  const response = await ack;
  eq(response.status, 200, "verified committed delivery acknowledges 200");
  ok(drainStarted, "the committed delivery starts its background drain");
  eq(h.waited.length, 1, "the route hands the drain to waitUntil exactly once");
  ok(!h.waited[0] || drainStarted, "the ACK does not require the drain promise to settle");
  eq(writes.length, 1, "the accepted delivery writes one durable row");
  releaseDrain();
  await Promise.all(h.waited);
}

{
  const h = harness();
  const raw = commentEvent({ id: "evt-b", data: { page_id: "page-b", parent: { id: "page-b", type: "page" }, ignored: "drop" } });
  const response = await h.acknowledge(raw, sign(raw, SECRET_B));
  eq(response.status, 200, "second configured integration is accepted");
  eq(h.writes[0]?.source, NOTION_INGRESS_SOURCE, "row uses the Notion ingress namespace");
  eq(h.writes[0]?.authorityId, "integration-b", "row authority is the integration whose secret verified the public bytes");
  eq(h.writes[0]?.deliveryId, "evt-b", "row is keyed by the vendor event id");
  const payload = decodeNotionIngressPayload(h.writes[0]!.payloadJson);
  eq(payload?.event.entity, { id: "comment-1", type: "comment" }, "stored entity keeps only routing fields");
  eq(payload?.event.data, { page_id: "page-b", parent: { id: "page-b", type: "page" } }, "stored data keeps only processing fields");
  ok(!h.writes[0]!.payloadJson.includes("drop-me") && !h.writes[0]!.payloadJson.includes("member-authored"), "stored payload excludes unneeded member-authored and unknown fields");
}

{
  const h = harness();
  const raw = JSON.stringify({
    id: "evt-struct-1",
    timestamp: "2026-09-17T09:01:00.000Z",
    type: "page.content_updated",
    workspace_id: "ws-1",
    entity: { id: "page-1", type: "page" },
    data: {
      parent: { id: "db-1", type: "database" },
      updated_blocks: [{ id: "block-1", text: "drop" }, { id: "block-2", text: "drop" }],
    },
    authors: [{ id: "person-1", type: "person", name: "drop" }],
  });
  await h.acknowledge(raw, sign(raw));
  const event = decodeNotionIngressPayload(h.writes[0]!.payloadJson)!.event;
  eq(event.timestamp, "2026-09-17T09:01:00.000Z", "structural occurrence time survives projection");
  eq(event.data?.updated_blocks, [{ id: "block-1" }, { id: "block-2" }], "all structural block ids and their cardinality survive projection");
  eq(event.authors, [{ id: "person-1", type: "person" }], "structural actor fields survive projection");
}

{
  const h = harness({ enqueue: async () => { throw new Error("store unavailable"); } });
  const raw = commentEvent();
  const response = await h.acknowledge(raw, sign(raw));
  eq(response.status, 503, "failed durable commit returns 503");
  eq(h.waited.length, 0, "failed durable commit schedules no drain");
}

{
  const h = harness();
  const raw = commentEvent();
  eq((await h.acknowledge(raw, sign(raw, "wrong"))).status, 401, "bad public HMAC is rejected");
  eq((await h.acknowledge(JSON.stringify({ ...JSON.parse(raw), id: "" }), sign(JSON.stringify({ ...JSON.parse(raw), id: "" })))).status, 400, "verified event without a stable vendor id is refused");
  eq(h.writes.length, 0, "rejected deliveries write no durable row");
}

{
  const h = harness();
  const oversized = "x".repeat(256 * 1024 + 1);
  const response = await h.acknowledge(oversized, null);
  eq(response.status, 413, "oversized public envelope is refused");
  eq(h.writes.length, 0, "oversized public envelope never reaches durable storage");
}

{
  const h = harness({ allowUnverified: true, signingKeys: [] });
  const raw = commentEvent();
  const response = await h.acknowledge(raw, null);
  eq(response.status, 409, "unverified development delivery tells the route to use its synchronous legacy path");
  eq(response.headers.get("x-oe-notion-ingress"), "synchronous", "the synchronous fallback is explicit to the route wrapper");
  eq(h.writes.length, 0, "unverified development delivery never enters the authenticated inbox");
}

console.log(`✓ notion ingress — ${passed} assertions`);
