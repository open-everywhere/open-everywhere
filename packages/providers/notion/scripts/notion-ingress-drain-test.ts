import assert from "node:assert/strict";

import type { ClaimedIngressDelivery, DueIngressDelivery, IngressDeliveryKey, OperationalStore } from "@open-everywhere/core/agent/adapter-api.js";
import {
  acceptNotionIngressDrainRequest,
  createNotionCommentDispatchGuard,
  NOTION_COMMENT_DISPATCH_AUTHORITY,
  NOTION_COMMENT_DISPATCH_SOURCE,
  NOTION_INGRESS_DRAIN_PATH,
  NOTION_INGRESS_DRAIN_SIGNATURE_HEADER,
  recoverNotionIngress,
  settleNotionIngressDrain,
  signNotionIngressDrainBody,
} from "../agent/channels/notion-ingress-drain.js";
import { NOTION_INGRESS_SOURCE } from "../agent/channels/notion-ingress.js";

let passed = 0;
function ok(value: unknown, label: string): void {
  assert.ok(value, label);
  passed++;
}
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}

const SECRET = "internal-drain-secret";
const NOW = new Date("2026-09-17T12:00:00.000Z");
const primaryKey = { source: NOTION_INGRESS_SOURCE, authorityId: "integration-a", deliveryId: "evt-1" } as const;
const payloadJson = JSON.stringify({
  schemaVersion: 1,
  event: {
    id: "evt-1",
    type: "comment.created",
    workspace_id: "ws-1",
    entity: { id: "comment-1", type: "comment" },
    data: { page_id: "page-1", parent: { id: "page-1", type: "page" } },
  },
});

interface StoreCalls {
  claims: Array<{ org: string; key: IngressDeliveryKey; claimId: string }>;
  enqueues: Array<{ org: string; key: IngressDeliveryKey; payloadJson: string }>;
  releases: Array<{ org: string; key: IngressDeliveryKey; claimId: string }>;
  completes: Array<{ org: string; key: IngressDeliveryKey; claimId: string; retainUntil: string }>;
  discards: Array<{ org: string; key: IngressDeliveryKey; claimId: string }>;
}

function storeHarness(input: {
  claim?: ClaimedIngressDelivery | null;
  claims?: readonly (ClaimedIngressDelivery | null)[];
  due?: readonly DueIngressDelivery[];
} = {}): { store: OperationalStore; calls: StoreCalls } {
  const calls: StoreCalls = { claims: [], enqueues: [], releases: [], completes: [], discards: [] };
  let claimIndex = 0;
  const store = {
    async enqueueIngressDelivery(org: string, write: { source: string; authorityId: string; deliveryId: string; payloadJson: string }) {
      calls.enqueues.push({ org, key: write, payloadJson: write.payloadJson });
      return true;
    },
    async listDueIngressDeliveries() {
      return input.due ?? [];
    },
    async claimIngressDelivery(org: string, key: IngressDeliveryKey, claimId: string) {
      calls.claims.push({ org, key, claimId });
      const configured = input.claims ? input.claims[claimIndex++] : input.claim;
      if (configured === null) return null;
      return configured ?? { ...key, payloadJson, receivedAt: NOW.toISOString(), availableAt: NOW.toISOString(), claimId, claimedAt: NOW.toISOString() };
    },
    async releaseIngressDelivery(org: string, key: IngressDeliveryKey, claimId: string) {
      calls.releases.push({ org, key, claimId });
      return true;
    },
    async completeIngressDelivery(org: string, key: IngressDeliveryKey, claimId: string, _completedAt: string, retainUntil: string) {
      calls.completes.push({ org, key, claimId, retainUntil });
      return true;
    },
    async discardIngressDelivery(org: string, key: IngressDeliveryKey, claimId: string) {
      calls.discards.push({ org, key, claimId });
      return true;
    },
  } as unknown as OperationalStore;
  return { store, calls };
}

function signedRequest(body: string, signature = signNotionIngressDrainBody(SECRET, body)): Request {
  return new Request(`https://agent.example${NOTION_INGRESS_DRAIN_PATH}`, {
    method: "POST",
    headers: { [NOTION_INGRESS_DRAIN_SIGNATURE_HEADER]: signature },
    body,
  });
}

{
  const { store, calls } = storeHarness();
  const body = JSON.stringify({ authorityId: primaryKey.authorityId, deliveryId: primaryKey.deliveryId, issuedAt: NOW.getTime() });
  const result = await acceptNotionIngressDrainRequest(signedRequest(body), {
    org: "org-a", store, secret: SECRET, now: () => NOW, claimId: () => "claim-primary",
  });
  ok("accepted" in result, "valid internal HMAC claims the durable row");
  if ("accepted" in result) {
    eq(result.accepted.signerCredentialId, "integration-a", "processor signer comes from the frozen authority key");
    eq(JSON.parse(result.accepted.rawBody).id, "evt-1", "processor receives the stored projected event");
  }
  eq(calls.claims[0]?.org, "org-a", "the request cannot choose another org partition");
  eq(calls.claims[0]?.key, primaryKey, "claim joins source, signer and delivery id exactly");
}

{
  const { store, calls } = storeHarness({ claim: null });
  const body = JSON.stringify({ authorityId: "integration-a", deliveryId: "evt-1", issuedAt: NOW.getTime() });
  const bad = await acceptNotionIngressDrainRequest(signedRequest(body, "sha256=bad"), { org: "org-a", store, secret: SECRET, now: () => NOW });
  ok("response" in bad && bad.response.status === 401, "invalid internal signature is refused");
  eq(calls.claims.length, 0, "invalid internal signature never reads a row");
  const staleBody = JSON.stringify({ authorityId: "integration-a", deliveryId: "evt-1", issuedAt: NOW.getTime() - 600_000 });
  const stale = await acceptNotionIngressDrainRequest(signedRequest(staleBody), { org: "org-a", store, secret: SECRET, now: () => NOW });
  ok("response" in stale && stale.response.status === 401, "stale signed envelope is refused");
  const duplicate = await acceptNotionIngressDrainRequest(signedRequest(body), { org: "org-a", store, secret: SECRET, now: () => NOW });
  ok("response" in duplicate && duplicate.response.status === 200, "non-claimable row is idempotently acknowledged");
}

{
  const { store, calls } = storeHarness();
  const oversized = new Request(`https://agent.example${NOTION_INGRESS_DRAIN_PATH}`, {
    method: "POST",
    body: "x".repeat(16 * 1024 + 1),
  });
  const refused = await acceptNotionIngressDrainRequest(oversized, { org: "org-a", store, now: () => NOW });
  ok("response" in refused && refused.response.status === 413, "oversized internal stream is refused before secret resolution");
  eq(calls.claims.length, 0, "oversized internal stream never reaches the store");
}

{
  for (const disposition of ["complete", "retry", "discard"] as const) {
    const { store, calls } = storeHarness();
    const body = JSON.stringify({ authorityId: "integration-a", deliveryId: "evt-1", issuedAt: NOW.getTime() });
    const admitted = await acceptNotionIngressDrainRequest(signedRequest(body), {
      org: "org-a", store, secret: SECRET, now: () => NOW, claimId: () => `claim-${disposition}`,
    });
    assert.ok("accepted" in admitted);
    await settleNotionIngressDrain(admitted.accepted, disposition, { org: "org-a", store, now: () => NOW });
    eq(calls.completes.length, disposition === "complete" ? 1 : 0, `${disposition}: completion transition is exact`);
    eq(calls.releases.length, disposition === "retry" ? 1 : 0, `${disposition}: retry transition is exact`);
    eq(calls.discards.length, disposition === "discard" ? 1 : 0, `${disposition}: refusal transition is exact`);
  }
}

{
  const due = [{ ...primaryKey, receivedAt: NOW.toISOString(), availableAt: NOW.toISOString() }];
  const { store } = storeHarness({ due });
  const requests: Array<{ url: string; body: string; signature: string | null }> = [];
  const result = await recoverNotionIngress("org-a", store, {
    secret: SECRET,
    baseUrl: "https://agent.example",
    now: () => NOW,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? ""), signature: new Headers(init?.headers).get(NOTION_INGRESS_DRAIN_SIGNATURE_HEADER) });
      return new Response("ok", { status: 200 });
    },
  });
  eq(result, { due: 1, posted: 1, failed: 0 }, "minute recovery nudges every due row without vendor traffic");
  eq(requests[0]?.url, `https://agent.example${NOTION_INGRESS_DRAIN_PATH}`, "recovery targets only the private drain route");
  ok(!requests[0]!.body.includes("comment.created") && !requests[0]!.body.includes("page-1"), "recovery self-hop contains no provider payload");
  ok(!!requests[0]?.signature, "recovery self-hop is HMAC authenticated");
}

{
  const claimed = { ...primaryKey, source: NOTION_COMMENT_DISPATCH_SOURCE, authorityId: NOTION_COMMENT_DISPATCH_AUTHORITY, deliveryId: "comment-1", payloadJson: "{}", receivedAt: NOW.toISOString(), availableAt: NOW.toISOString(), claimId: "secondary", claimedAt: NOW.toISOString() };
  const { store, calls } = storeHarness({ claims: [claimed, null] });
  const guard = createNotionCommentDispatchGuard({ org: "org-a", store, now: () => NOW, claimId: () => "secondary" });
  ok(await guard.claim("comment-1"), "first comment dispatch obtains a fenced lease");
  await guard.complete("comment-1");
  eq(
    calls.enqueues[0] && {
      source: calls.enqueues[0].key.source,
      authorityId: calls.enqueues[0].key.authorityId,
      deliveryId: calls.enqueues[0].key.deliveryId,
    },
    { source: NOTION_COMMENT_DISPATCH_SOURCE, authorityId: NOTION_COMMENT_DISPATCH_AUTHORITY, deliveryId: "comment-1" },
    "comment guard is org-global and comment-keyed across subscriptions",
  );
  ok(new Date(calls.completes[0]!.retainUntil).getTime() - NOW.getTime() === 10 * 60_000, "comment dispatch tombstone keeps the existing ten-minute dedupe horizon");
  const duplicate = createNotionCommentDispatchGuard({ org: "org-a", store, now: () => NOW, claimId: () => "secondary-2" });
  ok(!(await duplicate.claim("comment-1")), "active/completed comment guard refuses a duplicate wake");
  const otherComment = createNotionCommentDispatchGuard({ org: "org-a", store: storeHarness().store, now: () => NOW, claimId: () => "secondary-3" });
  ok(await otherComment.claim("comment-2"), "a different comment remains eligible after the cross-subscription duplicate");
}

console.log(`✓ notion ingress drain — ${passed} assertions`);
