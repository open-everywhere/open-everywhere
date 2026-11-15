import assert from "node:assert/strict";
process.env.OE_SQLITE_PATH = ":memory:";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { unifiedDomainSessionKey, dmWindowRegistryKey } from "../agent/channels/unified-supervisor.js";
import { saltSupervisorGeneration, formatWindowToken } from "../agent/channels/window-key.js";
import { getOrCreateDmSeat } from "../agent/channels/dm-seat.js";
import { renderWakeEnvelope, type WakeMessageInput } from "../agent/channels/wake-envelope.js";
import type { SessionTailEntry } from "../agent/channels/session-tail.js";
import type { OperationalStore } from "../agent/operational/store.js";
import { markSeatForRotation, markAllSeatsForRotation } from "./e2e/rotate-window-lib.js";
import { openTestPg, closeAllTestPg } from "./test-pg-driver.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq(a: unknown, b: unknown, label: string): void {
  if (a !== b) {
    console.error(`✗ ${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
    process.exit(1);
  }
  passed++;
}

const pg = await openTestPg();
const client: PgClient = pg.client;
await initOperationalSchema(client);
const store = makeOperationalPostgresStore(client);

const ORG = "default";
const AT = "2026-08-19T00:00:00.000Z";
const wakeEntry = (text: string, at: string): SessionTailEntry => ({ kind: "wake", at, from: "human", trust: "principal", author: "alice", authorId: "U_ALICE", text });
const postEntry = (text: string, at: string): SessionTailEntry => ({ kind: "post", at, from: "self", trust: "relay", author: "self", text });
const mintToken = (domain: string, generation: number): string =>
  saltSupervisorGeneration(formatWindowToken({ domain, windowId: domain, generation }));

const NO_CLOCK_ROTATION = {
  quietGapMs: Number.POSITIVE_INFINITY,
  expiryMs: Number.POSITIVE_INFINITY,
  turnBudget: Number.MAX_SAFE_INTEGER,
  tokenBudget: Number.MAX_SAFE_INTEGER,
  contextSizeTokens: Number.MAX_SAFE_INTEGER,
};
const noRuntimeRotation = async (): Promise<boolean> => false;

const CARRIED_WAKE = "where is the refund payment?";
const CARRIED_POST = "checking now";

{
  const key = unifiedDomainSessionKey("slack/T1/C1");
  const row = await store.rotateChannelSession(ORG, key, mintToken("slack/T1/C1", 1), AT);
  await store.appendSessionTail(ORG, key, row.token, wakeEntry(CARRIED_WAKE, "2026-08-18T23:00:00.000Z"));
  await store.appendSessionTail(ORG, key, row.token, postEntry(CARRIED_POST, "2026-08-18T23:01:00.000Z"));

  const result = await markSeatForRotation(store, ORG, key, "2026-08-19T00:05:00.000Z");
  ok(result !== null, "markSeatForRotation returns a result for a row that exists");
  eq(result!.markedAt, "2026-08-19T00:05:00.000Z", "…and the stamp it reports is READ BACK from the row, not the value it sent");
  eq(result!.generation, 1, "…the marked generation is the one that was live — the sweep advances nothing itself");
  eq(result!.token, row.token, "…and the token is unchanged, so the ring's partition still exists");
  eq(result!.tailPending, 2, "…tailPending FORECASTS both recorded entries (the room's question AND the seat's own answer)");

  const after = await store.getChannelSession(ORG, key);
  eq(after!.rotateMarkedAt, "2026-08-19T00:05:00.000Z", "the row itself reads back marked");
  eq(after!.generation, 1, "🔴 the sweep did NOT rotate — an out-of-band rotation is what destroyed the tail (OPE-820)");
  eq(
    (await store.readSessionTail(ORG, key, row.token)).length,
    2,
    "🔴 THE FIX, stated as a value: both entries are STILL IN THE RING and still readable under the live token. The old sweep read them, cleared the ring, and printed the count of what it had just destroyed.",
  );

  const again = await markSeatForRotation(store, ORG, key, "2026-08-19T03:00:00.000Z");
  eq(again!.markedAt, "2026-08-19T00:05:00.000Z", "a second mark keeps the FIRST stamp — the sweep is idempotent");
}

{
  const surface = "slack/T1/D0CARRY";
  const key = dmWindowRegistryKey(surface);
  const row = await store.rotateChannelSession(ORG, key, mintToken(`oe-dm/${surface}`, 1), AT);
  await store.appendSessionTail(ORG, key, row.token, wakeEntry(CARRIED_WAKE, "2026-08-18T23:00:00.000Z"));
  await store.appendSessionTail(ORG, key, row.token, postEntry(CARRIED_POST, "2026-08-18T23:01:00.000Z"));

  await markSeatForRotation(store, ORG, key, "2026-08-19T00:05:00.000Z");

  const seat = await getOrCreateDmSeat(ORG, { surfaceKey: surface }, "2026-08-19T00:06:00.000Z", {
    store,
    thresholds: NO_CLOCK_ROTATION,
    claimRuntimeRotation: noRuntimeRotation,
  });
  eq(seat.generation, 2, "🔴 the marked seat ROTATES on its next wake — in band, through the seat's own rotate leg");
  ok(seat.token !== row.token, "…minting a genuinely new token");
  ok(seat.freshGeneration, "…flagged fresh, so the surface renders the tail rather than suppressing it");
  eq(seat.tail.length, 2, "🔴 AND THE TAIL ARRIVES AT THE WAKE — 2 entries, carried by the rotation that the mark caused");
  eq(seat.tail[0]!.body, CARRIED_WAKE, "…the room's question first, verbatim");
  eq(seat.tail[1]!.body, CARRIED_POST, "…then the seat's own prior answer (OPE-804), in true conversation order");

  const trigger: WakeMessageInput = { from: "human", trust: "principal", author: "alice", body: "and now?", trigger: true, id: "1755000000.0001", sentAt: "2026-08-19T00:06:00.000Z" };
  const rendered = renderWakeEnvelope({
    reason: "dm",
    currentTime: "2026-08-19T00:06:00.000Z",
    channel: { id: "D0CARRY", type: "im" },
    messages: [...(seat.freshGeneration ? seat.tail : []), trigger],
  });
  ok(rendered.includes(CARRIED_WAKE), "🔴 the rendered wake envelope CONTAINS the carried question — the whole point, asserted on the bytes the model sees");
  ok(rendered.includes(CARRIED_POST), "…and the seat's own carried answer");
  ok(rendered.indexOf(CARRIED_WAKE) < rendered.indexOf("and now?"), "…both sit BEFORE the trigger message, which is what makes them backscroll");

  const afterRotate = await store.getChannelSession(ORG, key);
  eq(afterRotate!.rotateMarkedAt, null, "🔴 the rotation CLEARED the mark — asserted as null, not merely falsy");
  await store.touchChannelSession(ORG, key, "2026-08-19T00:06:05.000Z");
  const second = await getOrCreateDmSeat(ORG, { surfaceKey: surface }, "2026-08-19T00:07:00.000Z", {
    store,
    thresholds: NO_CLOCK_ROTATION,
    claimRuntimeRotation: noRuntimeRotation,
  });
  eq(second.generation, 2, "🔴 THE ANTI-AMNESIA CONTROL: the NEXT wake resumes generation 2. A mark that survived its own rotation would retire the seat on every wake for ever.");
  eq(second.freshGeneration, false, "…as an ordinary resume");
  eq(second.tail.length, 0, "…carrying no tail, because the tail was already delivered to the wake that rotated");
}

{
  const surface = "slack/T1/D0QUIET";
  const key = dmWindowRegistryKey(surface);
  const row = await store.rotateChannelSession(ORG, key, mintToken(`oe-dm/${surface}`, 1), AT);
  await store.appendSessionTail(ORG, key, row.token, wakeEntry("unmarked question", "2026-08-18T23:00:00.000Z"));

  const seat = await getOrCreateDmSeat(ORG, { surfaceKey: surface }, "2026-08-19T00:06:00.000Z", {
    store,
    thresholds: NO_CLOCK_ROTATION,
    claimRuntimeRotation: noRuntimeRotation,
  });
  eq(seat.generation, 1, "🔴 an UNMARKED seat does NOT rotate at the same instant — the mark is what fires the rung, not a clock");
  eq(seat.token, row.token, "…it keeps its live token");
  eq(seat.tail.length, 0, "…and carries no tail, because it did not rotate");
  eq((await store.readSessionTail(ORG, key, row.token)).length, 1, "…its ring is untouched, waiting for the rotation that eventually comes");
}

{
  const key = unifiedDomainSessionKey("slack/T5/C5");
  await store.rotateChannelSession(ORG, key, mintToken("slack/T5/C5", 1), AT);
  const deaf: OperationalStore = { ...store, markChannelSessionRotation: async () => true };
  let threw = "";
  try {
    await markSeatForRotation(deaf, ORG, key, "2026-08-19T00:05:00.000Z");
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("read back UNMARKED"), "🔴 a store whose mark does not stick makes the sweep THROW, naming the row — it never reports a mark it cannot read back");
  eq((await store.getChannelSession(ORG, key))!.rotateMarkedAt, null, "…and the row is genuinely still unmarked (the negative control for the throw)");
}

{
  const keyA = unifiedDomainSessionKey("slack/S1/C1");
  const keyB = unifiedDomainSessionKey("slack/S2/C2");
  const rowA = await store.rotateChannelSession(ORG, keyA, mintToken("slack/S1/C1", 1), AT);
  await store.rotateChannelSession(ORG, keyB, mintToken("slack/S2/C2", 1), AT);
  await store.appendSessionTail(ORG, keyA, rowA.token, wakeEntry("sweep question", "2026-08-18T23:00:00.000Z"));

  await store.rotateChannelSession(ORG, "slack/LEGACY/C9", mintToken("slack/LEGACY/C9", 1), AT);
  const org2 = "sweep-org";
  await store.rotateChannelSession(org2, keyA, mintToken("slack/S1/C1", 1), AT);

  const { marked, vanished } = await markAllSeatsForRotation(store, ORG, "2026-08-19T01:00:00.000Z");
  eq(vanished.length, 0, "nothing vanished mid-sweep in this single-threaded run");
  const mA = marked.find((m) => m.registryKey === keyA);
  const mB = marked.find((m) => m.registryKey === keyB);
  ok(mA !== undefined && mB !== undefined, "the sweep marked BOTH rows seeded for this org's oe-domain:: prefix");
  eq(mA!.tailPending, 1, "…forecasting the populated row's one entry");
  eq(mB!.tailPending, 0, "🔴 tailPending is explicitly 0 on the empty row (asserted as a value, not merely falsy) — the bootstrap case, marked like any other");
  ok(!marked.some((m) => m.registryKey === "slack/LEGACY/C9"), "…and the non-prefixed legacy row is excluded by the prefix filter");
  eq((await store.getChannelSession(ORG, "slack/LEGACY/C9"))!.rotateMarkedAt, null, "…which is a real exclusion: that row reads back UNMARKED");
  eq((await store.getChannelSession(org2, keyA))!.rotateMarkedAt, null, "🔴 an org-scoped sweep NEVER marks another org's row sharing the same registry key — org isolation holds");
  eq((await store.readSessionTail(ORG, keyA, rowA.token)).length, 1, "🔴 the sweep destroyed nothing: every marked seat's ring is intact and waiting for its own wake");

  const gone = await markSeatForRotation(store, ORG, unifiedDomainSessionKey("slack/NEVER-SEEN/C9"), AT);
  eq(gone, null, "a registryKey with no channel_session row returns null — nothing to rotate, not an error, and no row is created");
  eq(await store.getChannelSession(ORG, unifiedDomainSessionKey("slack/NEVER-SEEN/C9")), null, "…proven: the mark is an UPDATE, never an upsert");
}

{
  const key = unifiedDomainSessionKey("slack/LITE/C1");
  const s = sqliteOperationalStore;
  eq(await s.markChannelSessionRotation(ORG, key, AT), false, "sqlite: marking a registryKey with no row returns FALSE — nothing to rotate");
  eq(await s.getChannelSession(ORG, key), null, "…and creates nothing (an UPDATE, never an upsert)");

  const row = await s.rotateChannelSession(ORG, key, mintToken("slack/LITE/C1", 1), AT);
  eq(row.rotateMarkedAt, null, "sqlite: a freshly minted generation is unmarked");
  eq(await s.markChannelSessionRotation(ORG, key, "2026-08-19T00:05:00.000Z"), true, "sqlite: marking an existing row returns TRUE");
  eq((await s.getChannelSession(ORG, key))!.rotateMarkedAt, "2026-08-19T00:05:00.000Z", "…and the stamp reads back");
  await s.markChannelSessionRotation(ORG, key, "2026-08-19T09:00:00.000Z");
  eq((await s.getChannelSession(ORG, key))!.rotateMarkedAt, "2026-08-19T00:05:00.000Z", "sqlite: a second mark keeps the FIRST stamp — idempotent, like Postgres");
  eq((await s.listChannelSessions(ORG, "oe-domain::")).find((r) => r.surfaceKey === key)!.rotateMarkedAt, "2026-08-19T00:05:00.000Z", "sqlite: listChannelSessions carries the mark, so a sweep can see it");

  const rotated = await s.rotateChannelSession(ORG, key, mintToken("slack/LITE/C1", 2), "2026-08-19T00:06:00.000Z");
  eq(rotated.rotateMarkedAt, null, "sqlite: the rotation REPORTS the mark as spent");
  eq((await s.getChannelSession(ORG, key))!.rotateMarkedAt, null, "🔴 sqlite: and the STORED row agrees on a fresh read — the upsert really cleared it, so the next wake resumes instead of rotating for ever");
}

assert.ok(passed > 0, "at least one assertion ran");
console.log(`✓ rotate-all-carry-tail: ${passed} assertions passed (the mark sticks and destroys nothing, the next wake rotates in band and renders the carried tail, the mark is spent, an unmarked seat does not rotate, an unstuck mark throws, and the sweep's prefix/org isolation holds)`);
await closeAllTestPg();
