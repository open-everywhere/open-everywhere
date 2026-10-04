import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  auditCursor,
  awaitProseRedriveSettled,
  bootAgent,
  disposeLater,
  registerScript,
  REPLAYED_DELIVERY_CALLER_BODY,
  rowsSinceCursor,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  seatReply,
  waitFor,
  webhookDeliveryPost,
} from "../harness";

test("a signed delivery is accepted (200), fires, and its webhook.fired row joins to the reply.post row it caused", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const deliveryId = `it-fire-${nonce}`;
  const replyText = `oe-webhook-it-ok ${nonce}`;
  const handle = disposeLater(registerScript({ parent: [seatReply(replyText, `webhook-it-${nonce}`), { say: "NO_REPLY" }] }));

  const cursor = await auditCursor();
  const res = await webhookDeliveryPost({ note: nonce }, { deliveryId });
  expect(res.status).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");

  const fired = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["webhook.fired"]);
    return rows.find((r) => r.detail?.hookId === "e2e-smoke" && r.detail?.deliveryId === deliveryId);
  }, "the webhook.fired row for this delivery id");
  expect(fired.detail?.source).toBe("oe-standard-webhook");
  expect(fired.detail?.posture).toBe("content-bearing");
  expect(typeof fired.detail?.wakeId).toBe("string");
  expect((fired.detail?.wakeId as string).length).toBeGreaterThan(0);

  const reply = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.detail?.wakeId === fired.detail?.wakeId);
  }, "the reply.post row this delivery's wakeId joins to");
  expect(String(reply.detail?.id)).toMatch(/^spoof-/);
  expect(reply.detail?.platform).toBe("slack");
  expect(reply.detail?.chars).toBe(replyText.length);

  expect(reply.detail?.route).toBe("tool");
  expect(reply.detail).not.toHaveProperty("creatorId");
});

test("an unsigned delivery is refused 401, and writes NO webhook.fired row", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const nonce = randomBytes(6).toString("hex");
  const deliveryId = `it-unsigned-${nonce}`;

  const res = await webhookDeliveryPost({ note: nonce }, { signed: false, deliveryId });
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await rowsSinceCursor(cursor, ["webhook.fired"]);
  expect(rows.find((r) => r.detail?.deliveryId === deliveryId)).toBeUndefined();
});

test("a replayed delivery id is refused 409 on the second POST, and only the first delivery's fire is audited", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const deliveryId = `it-replay-${nonce}`;
  const replyText = `oe-webhook-it-replay ${nonce}`;
  const handle = disposeLater(registerScript({ parent: [{ say: replyText }] }));

  const cursor = await auditCursor();
  const first = await webhookDeliveryPost({ note: nonce }, { deliveryId });
  expect(first.status).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the first delivery");

  const second = await webhookDeliveryPost({ note: nonce }, { deliveryId });
  expect(second.status).toBe(409);
  expect(second.body).toBe(REPLAYED_DELIVERY_CALLER_BODY);

  const fired = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["webhook.fired"]);
    const matching = rows.filter((r) => r.detail?.deliveryId === deliveryId);
    return matching.length > 0 ? matching : undefined;
  }, "the first delivery's webhook.fired row");
  expect(fired.length).toBe(1);

  await awaitProseRedriveSettled(cursor, "the replayed delivery's turn");
});

test("a content-bearing hook's raw body reaches the model FENCED inside the untrusted envelope, and the operator instruction sits outside it", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const marker = `oe-it-webhook-body-${nonce}`;
  const handle = disposeLater(registerScript({ parent: [{ say: "ack" }] }));

  const cursor = await auditCursor();
  const res = await webhookDeliveryPost({ note: marker });
  expect(res.status).toBe(200);

  const firstReq = await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the parent's first request");
  const carrier = firstReq.messages.find((m) => m.text.includes(marker));
  expect(carrier, "the parent's first request carries no message with this delivery's marker — the handle served a different wake, so a previous turn had not settled").toBeDefined();
  const text = carrier!.text;
  const open = text.indexOf(UNTRUSTED_OPEN);
  const bodyIdx = text.indexOf(marker);
  const close = text.indexOf(UNTRUSTED_CLOSE);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(bodyIdx).toBeGreaterThan(open);
  expect(close).toBeGreaterThan(bodyIdx);

  expect(text.slice(0, open)).not.toContain(marker);

  const instructionIdx = text.indexOf("own smoke-test webhook");
  expect(instructionIdx).toBeGreaterThanOrEqual(0);
  expect(instructionIdx).toBeLessThan(open);
  expect(text.lastIndexOf("<system-note>", instructionIdx)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("</system-note>", instructionIdx)).toBeLessThan(open);

  await awaitProseRedriveSettled(cursor, "the fenced delivery's turn");
});
