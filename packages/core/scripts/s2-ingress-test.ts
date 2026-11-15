// proves: thread.ingress_routed
// proves: DELG-49

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-s2-ingress-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { divertToUnifiedWindow, divertInboundToUnifiedWindow, type UnifiedReceiveTarget } from "../agent/channels/unified.js";
import { registerSettings } from "../agent/settings/settings.js";
import { RateLimitExhaustedError } from "../agent/channels/rate-limit-retry.js";
import { recordThreadOwner, resolveThreadOwner, clearThreadOwner } from "../agent/channels/thread-ownership.js";
import { recordThreadSeatOpen } from "../agent/channels/thread-seat-state.js";
import { unifiedThreadRef, isThreadScopedWakeOrigin, mintWakeId, OE_GRAIN_ATTR, OE_ADDRESSING_ATTR, OE_DELIVERY_ID_ATTR, type UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import { formatWindowToken, taskWindowId, threadSeatWindowId } from "../agent/channels/window-key.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { deploymentOrg } from "../agent/identity/binding.js";
import { readAudit } from "../agent/audit/audit.js";
import type { RouteHandlerArgs } from "eve/channels";

import { registerSlackFixtureMapper, registerSlackFixtureCodec } from "./_slack-test-stubs.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();
registerSlackFixtureCodec();

let n = 0;
const ok = (cond: boolean, label: string) => { assert.ok(cond, label); n++; };
const eq = (a: unknown, b: unknown, label: string) => { assert.deepStrictEqual(a, b, label); n++; };

const ORG = deploymentOrg();
const store = getOperationalStore();
const DOMAIN = "payments";
const GEN = 3;
const STANDING = formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: GEN });
const ORIGIN: UnifiedWakeOrigin = { platform: "slack", channelId: "C1", threadTs: "170.5" };
const REF = unifiedThreadRef(ORIGIN);
const SEAT = formatWindowToken({ domain: DOMAIN, windowId: threadSeatWindowId(REF.channelKey, REF.threadKey), generation: GEN });
const TASK = formatWindowToken({ domain: DOMAIN, windowId: taskWindowId(REF.channelKey, REF.threadKey), generation: GEN });
const SURFACE_KEY = "slack/T1/C1";

interface ReceivedWake { message: string; target: UnifiedReceiveTarget; auth: { attributes?: Record<string, unknown> } }
const received: ReceivedWake[] = [];
let failOnToken: string | undefined;
let rateLimitOnToken: string | undefined;
const captureReceive = ((_ch: unknown, rawTarget: unknown) => ({
  async send(message: string, options: { auth: unknown }) {
    const target = rawTarget as UnifiedReceiveTarget;
    if (failOnToken !== undefined && target.token === failOnToken) throw new Error("injected owner-delivery failure");
    if (rateLimitOnToken !== undefined && target.token === rateLimitOnToken) {
      const err = new Error("Too many requests — please retry later");
      err.name = "TooManyRequestsError";
      throw err;
    }
    received.push({ message, target, auth: options.auth as ReceivedWake["auth"] });
    return undefined as never;
  },
})) as unknown as RouteHandlerArgs["to"];

const inbound = (wakeId: string, token = STANDING, origin: UnifiedWakeOrigin = ORIGIN) => ({
  message: "<wake>hello</wake>",
  token,
  window: { wakeId, origin, addressing: "direct-mention" as const },
  surfaceKey: SURFACE_KEY,
  auth: { attributes: { team_id: "T1", channel_id: "C1" } },
});

const ingressAudit = () => readAudit({ org: ORG, action: "thread.ingress_routed" });

function eqDeliveryModuloNonce(a: ReceivedWake, b: ReceivedWake, label: string): void {
  const nonceA = a.auth.attributes?.[OE_DELIVERY_ID_ATTR];
  const nonceB = b.auth.attributes?.[OE_DELIVERY_ID_ATTR];
  ok(typeof nonceA === "string" && nonceA.length > 0, `${label} — precondition: the first delivery carries an ${OE_DELIVERY_ID_ATTR} nonce`);
  ok(typeof nonceB === "string" && nonceB.length > 0, `${label} — precondition: the second one does too`);
  ok(nonceA !== nonceB, `🔴 ${label} — the two nonces DIFFER, which is the whole point of the stamp: it is what proves a delivery arrived`);
  const strip = (d: ReceivedWake) => {
    const { [OE_DELIVERY_ID_ATTR]: _drop, ...rest } = d.auth.attributes ?? {};
    return { ...d, auth: { ...d.auth, attributes: rest } };
  };
  eq(strip(a), strip(b), label);
}

registerSettings({ delegation: { oneshotAgent: false } });

async function withFlag<T>(armed: boolean, fn: () => Promise<T>): Promise<T> {
  registerSettings({ delegation: { oneshotAgent: armed } });
  try {
    return await fn();
  } finally {
    registerSettings({ delegation: { oneshotAgent: false } });
  }
}

console.log("1. flag-off byte-identical passthrough:");
{
  await recordThreadOwner(store, ORG, REF, SEAT, new Date().toISOString());
  const wakeId = mintWakeId();
  await divertInboundToUnifiedWindow(captureReceive, inbound(wakeId));
  await divertToUnifiedWindow(captureReceive, inbound(wakeId));
  eq(received.length, 2, "flag off: exactly one delivery per divert (no owner re-dispatch)");
  eqDeliveryModuloNonce(received[0]!, received[1]!, "flag off: the inbound variant's delivery is BYTE-IDENTICAL to the raw divert's (same target, same stamped auth) despite a live owner row");
  eq(received[0].target.token, STANDING, "flag off: delivered to the STANDING token");
  eq((await ingressAudit()).length, 0, "flag off: NO thread.ingress_routed audit row (nothing consulted)");
  received.length = 0;
}

console.log("2. no-owner passthrough (flag on):");
await withFlag(true, async () => {
  await clearThreadOwner(store, ORG, REF);
  const wakeId = mintWakeId();
  await divertInboundToUnifiedWindow(captureReceive, inbound(wakeId));
  await divertToUnifiedWindow(captureReceive, inbound(wakeId));
  eqDeliveryModuloNonce(received[0]!, received[1]!, "no owner: the delivery is byte-identical to the raw divert's (standing token, standing grain)");
  eq(received[0].auth.attributes?.[OE_GRAIN_ATTR], "standing", "no owner: the stamped grain is the divert default (standing)");
  eq((await ingressAudit()).length, 0, "no owner: NO audit row (a plain unowned message is not an event — actions-only)");
  received.length = 0;
});

console.log("3. owned-thread divert (thread seat):");
await withFlag(true, async () => {
  await recordThreadOwner(store, ORG, REF, SEAT, new Date().toISOString());
  const wakeId = mintWakeId();
  await divertInboundToUnifiedWindow(captureReceive, inbound(wakeId));
  eq(received.length, 1, "owned: exactly ONE delivery (the standing seat is NOT also woken)");
  eq(received[0].target.token, SEAT, "owned: delivered to the OWNER (thread seat) token, not the standing seat's");
  eq(received[0].target.wakeId, wakeId, "owned: the wakeId rides through unchanged (the reply map still keys the origin)");
  eq(received[0].target.origin, ORIGIN, "owned: the origin (surface identity) is the standing path's exact shape — credentials/memory resolve the same");
  eq(received[0].target.surfaceKey, SURFACE_KEY, "owned: the surfaceKey re-check input is unchanged");
  eq(received[0].auth.attributes?.[OE_GRAIN_ATTR], "thread", "owned: oe_grain is re-stamped to the seat's NARROW grain (never widened)");
  eq(received[0].auth.attributes?.[OE_ADDRESSING_ATTR], "direct-mention", "owned: an addressed mention keeps its owed-reply bridge on the seat");
  eq(received[0].auth.attributes?.team_id, "T1", "owned: the surface's own auth attributes are still forwarded verbatim");
  const rows = await ingressAudit();
  eq(rows.length, 1, "owned: exactly one thread.ingress_routed audit row");
  const detail = rows[0].detail as Record<string, unknown>;
  eq(detail.routed, "owner", "audit: routed=owner");
  eq(detail.ownerId, SEAT, "audit: ownerId names the seat token");
  eq(detail.grain, "thread", "audit: grain=thread");
  eq(detail.wakeId, wakeId, "audit: the row is wakeId-stamped");
  eq(detail.channelKey, REF.channelKey, "audit: channelKey is the shared thread-ref derivation");
  eq(detail.threadKey, REF.threadKey, "audit: threadKey is the shared thread-ref derivation");
  ok(!("message" in detail) && !("text" in detail) && !("brief" in detail), "audit: detail carries ids/counts ONLY — never message text (house discipline)");
  eq(rows[0].workspace, DOMAIN, "audit: workspace = the standing window's domain");
  received.length = 0;
});

console.log("4. owned-thread divert (task worker):");
await withFlag(true, async () => {
  await recordThreadOwner(store, ORG, REF, TASK, new Date().toISOString());
  await divertInboundToUnifiedWindow(captureReceive, inbound(mintWakeId()));
  eq(received[0].target.token, TASK, "task owner: delivered to the task token");
  eq(received[0].auth.attributes?.[OE_GRAIN_ATTR], "task", "task owner: oe_grain=task (the wide hands the worker booted with)");
  received.length = 0;
});

console.log("5. stale-owner fallback (rotation, task owner):");
await withFlag(true, async () => {
  const staleTask = formatWindowToken({ domain: DOMAIN, windowId: taskWindowId(REF.channelKey, REF.threadKey), generation: GEN - 1 });
  await recordThreadOwner(store, ORG, REF, staleTask, new Date().toISOString());
  const before = (await ingressAudit()).length;
  const wakeId = mintWakeId();
  await divertInboundToUnifiedWindow(captureReceive, inbound(wakeId));
  eq(received.length, 1, "stale: exactly one delivery (never dropped)");
  eq(received[0].target.token, STANDING, "stale: a rotated-generation TASK owner is IGNORED — the standing seat wakes");
  eq(await resolveThreadOwner(store, ORG, REF), null, "stale: the dead row was lazily REAPED (generation-bump GC)");
  const rows = await ingressAudit();
  eq(rows.length, before + 1, "stale: the fallback decision is audited");
  const detail = rows[0].detail as Record<string, unknown>;
  eq(detail.routed, "standing", "audit: routed=standing");
  eq(detail.reason, "stale-owner", "audit: reason=stale-owner");
  eq(detail.ownerId, staleTask, "audit: the reaped owner is named");
  eq(detail.reaped, true, "audit: the reap is recorded");
  received.length = 0;
});

console.log("5b. thread seat survives the parent's rotation; a routed message touches it:");
await withFlag(true, async () => {
  const olderSeat = formatWindowToken({ domain: DOMAIN, windowId: threadSeatWindowId(REF.channelKey, REF.threadKey), generation: GEN - 1 });
  const longAgo = "2026-01-01T00:00:00.000Z";
  await recordThreadOwner(store, ORG, REF, olderSeat, longAgo);
  await recordThreadSeatOpen(store, ORG, REF, { seatToken: olderSeat, parentRegistryKey: "unified-domain:payments", origin: ORIGIN, atIso: longAgo });
  await divertInboundToUnifiedWindow(captureReceive, inbound(mintWakeId()));
  eq(received.length, 1, "rotated parent: exactly one delivery");
  eq(received[0].target.token, olderSeat, "rotated parent: the message still reaches the THREAD SEAT — no silent orphan");
  eq(received[0].auth.attributes?.[OE_GRAIN_ATTR], "thread", "rotated parent: oe_grain=thread (the seat's narrow hands)");
  eq(await resolveThreadOwner(store, ORG, REF), olderSeat, "rotated parent: the ownership row is KEPT, not reaped");
  const state = await store.getThreadSeatState(ORG, REF.channelKey, REF.threadKey);
  ok(state !== null && state.state === "open" && state.updatedAt > longAgo, "activity: the routed message moved the seat's last-activity stamp forward");
  const idle = await store.listIdleThreadSeats(ORG, "2026-06-01T00:00:00.000Z", 10);
  ok(!idle.some((r) => r.threadKey === REF.threadKey), "activity: a thread somebody just wrote in is not idle");
  await clearThreadOwner(store, ORG, REF);
  received.length = 0;
});

console.log("6. re-homed-domain fallback:");
await withFlag(true, async () => {
  const foreign = formatWindowToken({ domain: "treasury", windowId: threadSeatWindowId(REF.channelKey, REF.threadKey), generation: GEN });
  await recordThreadOwner(store, ORG, REF, foreign, new Date().toISOString());
  await recordThreadSeatOpen(store, ORG, REF, { seatToken: foreign, parentRegistryKey: "unified-domain:treasury", origin: ORIGIN, atIso: new Date().toISOString() });
  const closedBefore = (await readAudit({ org: ORG, action: "thread_seat.closed" })).length;
  await divertInboundToUnifiedWindow(captureReceive, inbound(mintWakeId()));
  eq(received[0].target.token, STANDING, "re-homed: a foreign-domain owner never captures this window's traffic — standing wakes");
  eq(await resolveThreadOwner(store, ORG, REF), null, "re-homed: the dead row was reaped");
  eq((await store.getThreadSeatState(ORG, REF.channelKey, REF.threadKey))?.state, "closed", "re-homed: the seat's record says the HOST closed it");
  const closed = await readAudit({ org: ORG, action: "thread_seat.closed" });
  eq(closed.length, closedBefore + 1, "re-homed: the close is audited as thread_seat.closed");
  eq((closed[0].detail as Record<string, unknown>).reason, "closed", "audit: reason=closed");
  received.length = 0;
});

console.log("7. owner-divert failure fallback:");
await withFlag(true, async () => {
  await recordThreadOwner(store, ORG, REF, SEAT, new Date().toISOString());
  const before = (await ingressAudit()).length;
  failOnToken = SEAT;
  const wakeId = mintWakeId();
  await divertInboundToUnifiedWindow(captureReceive, inbound(wakeId));
  failOnToken = undefined;
  eq(received.length, 1, "failure: the message still lands (exactly once, on the fallback)");
  eq(received[0].target.token, STANDING, "failure: the fallback delivery targets the STANDING seat");
  const rows = await ingressAudit();
  eq(rows.length, before + 1, "failure: the fallback is audited");
  const detail = rows[0].detail as Record<string, unknown>;
  eq(detail.routed, "standing", "audit: routed=standing");
  eq(detail.reason, "owner-divert-failed", "audit: reason=owner-divert-failed");
  eq(detail.ownerId, SEAT, "audit: the failed owner is named");
  ok(typeof detail.error === "string" && (detail.error as string).includes("injected"), "audit: the (token-free) error rides for diagnosis");
  ok(await resolveThreadOwner(store, ORG, REF) === SEAT, "failure: the owner row is NOT reaped (the owner may recover; TTL/complete_thread still clear it)");
  await clearThreadOwner(store, ORG, REF);
  received.length = 0;
});

console.log("8. non-standing target passthrough:");
await withFlag(true, async () => {
  await recordThreadOwner(store, ORG, REF, SEAT, new Date().toISOString());
  const before = (await ingressAudit()).length;
  await divertInboundToUnifiedWindow(captureReceive, inbound(mintWakeId(), TASK));
  eq(received[0].target.token, TASK, "a task-token target passes through untouched (no ownership consult)");
  eq((await ingressAudit()).length, before, "no audit row for the defensive passthrough");
  await clearThreadOwner(store, ORG, REF);
  received.length = 0;
});

console.log("9. channel-capture guard (top-level vs thread):");
await withFlag(true, async () => {
  const TOP_ORIGIN: UnifiedWakeOrigin = { platform: "slack", channelId: "C1" };
  const topRef = unifiedThreadRef(TOP_ORIGIN);
  eq(topRef, { channelKey: "slack/C1", threadKey: "C1" }, "a top-level wake's threadKey IS the channelId fallback (why the capture was possible)");
  const channelSeat = formatWindowToken({ domain: DOMAIN, windowId: threadSeatWindowId(topRef.channelKey, topRef.threadKey), generation: GEN });
  await recordThreadOwner(store, ORG, topRef, channelSeat, new Date().toISOString());
  const before = (await ingressAudit()).length;
  await divertInboundToUnifiedWindow(captureReceive, inbound(mintWakeId(), STANDING, TOP_ORIGIN));
  eq(received.length, 1, "top-level: exactly one delivery");
  eq(received[0].target.token, STANDING, "top-level: routes STANDING unconditionally — a live channel-keyed owner row never captures top-level traffic");
  eq(received[0].auth.attributes?.[OE_GRAIN_ATTR], "standing", "top-level: no owner grain stamped (the standing divert default)");
  eq((await ingressAudit()).length, before, "top-level: no audit row (no lookup happened — not a routing decision)");
  eq(await resolveThreadOwner(store, ORG, topRef), channelSeat, "top-level: the channel-keyed row is untouched (NOT reaped — no lookup by design; TTL/complete_thread clear it)");
  received.length = 0;
  await recordThreadOwner(store, ORG, REF, SEAT, new Date().toISOString());
  await divertInboundToUnifiedWindow(captureReceive, inbound(mintWakeId()));
  eq(received[0].target.token, SEAT, "thread: a threaded message in the same channel still diverts to its thread's owner");
  await clearThreadOwner(store, ORG, REF);
  await clearThreadOwner(store, ORG, topRef);
  received.length = 0;
});

console.log("10. isThreadScopedWakeOrigin predicate:");
{
  eq(isThreadScopedWakeOrigin({ platform: "slack", channelId: "C1", threadTs: "170.5" }), true, "slack: threadTs present ⇒ thread-scoped");
  eq(isThreadScopedWakeOrigin({ platform: "slack", channelId: "C1" }), false, "slack: no threadTs ⇒ top-level (standing's domain)");
}

console.log("11. a rate-limited owner divert does not spend a second budget:");
await withFlag(true, async () => {
  await recordThreadOwner(store, ORG, REF, SEAT, new Date().toISOString());
  const before = (await ingressAudit()).length;
  const ingressBefore = (await readAudit({ org: ORG, action: "wake.ingress" })).length;
  rateLimitOnToken = SEAT;
  const wakeId = mintWakeId();
  let threw: unknown;
  try {
    await divertInboundToUnifiedWindow(captureReceive, inbound(wakeId));
  } catch (err) {
    threw = err;
  }
  rateLimitOnToken = undefined;

  ok(threw instanceof RateLimitExhaustedError, "🔴 11: an exhausted owner divert RETHROWS to the surface's loud catch — it does not fall back");
  eq(received.length, 0, "🔴 11: …and no second, standing delivery was attempted against the same refusing queue");
  const rows = await ingressAudit();
  eq(rows.length, before + 1, "11: the decision is audited exactly once");
  const detail = rows[0].detail as Record<string, unknown>;
  eq(detail.reason, "owner-divert-rate-limited", "11: audit: the reason names the rate limit, not a generic owner failure");
  eq(detail.routed, "none", "🔴 11: audit: routed=none — the wake reached NEITHER seat, which is what an operator must see");
  ok(typeof detail.attempts === "number" && (detail.attempts as number) > 1, "11: audit: the attempts spent ride the row");
  eq((await readAudit({ org: ORG, action: "wake.ingress" })).length, ingressBefore + 1, "🔴 11: exactly ONE wake.ingress row for this wake — a fallback would have written a second");
  await clearThreadOwner(store, ORG, REF);
  received.length = 0;
});

console.log(`s2-ingress-test: ${n} assertions passed`);
