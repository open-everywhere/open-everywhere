import assert from "node:assert/strict";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { saltSupervisorGeneration, formatWindowToken } from "../agent/channels/window-key.js";
import type { SessionTailEntry } from "../agent/channels/session-tail.js";
import { rotateSeatCarryingTail, rotateAllSeatsCarryingTail } from "./e2e/rotate-window-lib.js";
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

{
  const keyA = unifiedDomainSessionKey("slack/T1/C1");
  const keyB = unifiedDomainSessionKey("slack/T2/C2");

  const rowA = await store.rotateChannelSession(ORG, keyA, saltSupervisorGeneration(formatWindowToken({ domain: "slack/T1/C1", windowId: "slack/T1/C1", generation: 1 })), AT);
  const rowB = await store.rotateChannelSession(ORG, keyB, saltSupervisorGeneration(formatWindowToken({ domain: "slack/T2/C2", windowId: "slack/T2/C2", generation: 1 })), AT);

  const CARRIED_WAKE = "what's the refund status?";
  const CARRIED_POST = "checking now";
  for (const key of [keyA, keyB]) {
    const token = key === keyA ? rowA.token : rowB.token;
    await store.appendSessionTail(ORG, key, token, wakeEntry(CARRIED_WAKE, "2026-08-18T23:00:00.000Z"));
    await store.appendSessionTail(ORG, key, token, postEntry(CARRIED_POST, "2026-08-18T23:01:00.000Z"));
  }

  const resultA = await rotateSeatCarryingTail(store, ORG, keyA, "2026-08-19T00:05:00.000Z");
  ok(resultA !== null, "rotateSeatCarryingTail returns a result for a row that exists");
  eq(resultA!.oldGeneration, 1, "…rotates FROM generation 1");
  eq(resultA!.newRow.generation, 2, "…TO generation 2 — the store's own atomic +1, never re-derived by this tool");
  ok(resultA!.newToken !== rowA.token, "…mints a genuinely new token");
  eq(resultA!.tailCarried, 2, "🔴 both recorded entries (the room's question AND the seat's own answer) ride across — a raw swap carries neither");
  eq(resultA!.tail.length, 2, "…the CONTENT is exposed, not just a count");
  ok(resultA!.tail.some((m) => m.body === CARRIED_WAKE), "…the carried tail includes the room's question, verbatim");
  ok(resultA!.tail.some((m) => m.body === CARRIED_POST), "…AND the seat's own prior answer (OPE-804 — this is the NEW cost a raw swap now pays)");
  ok(resultA!.tail[0]!.body === CARRIED_WAKE && resultA!.tail[1]!.body === CARRIED_POST, "…in TRUE conversation order (question before answer)");
  eq((await store.readSessionTail(ORG, keyA, rowA.token)).length, 0, "🔴 the OUTGOING generation's ring is CLEARED once carried — proof it was actually READ, not merely left behind");

  const rawNewToken = saltSupervisorGeneration(formatWindowToken({ domain: "slack/T2/C2", windowId: "slack/T2/C2", generation: 2 }));
  const rowBRotated = await store.rotateChannelSession(ORG, keyB, rawNewToken, "2026-08-19T00:05:00.000Z");
  eq(rowBRotated.generation, 2, "the raw swap still advances the generation counter — the row LOOKS rotated");
  ok(rowBRotated.token !== rowB.token, "…and mints a new token, same as path A");
  eq(
    (await store.readSessionTail(ORG, keyB, rowB.token)).length,
    2,
    "🔴 THE DEFECT, contrasted directly: the raw swap's OUTGOING ring is NEVER READ — both entries are still sitting under the old token, orphaned. Nothing under the NEW generation will ever see them; the next wake pays the platform-fetch fallback (measured live at deploy #90).",
  );
}

{
  const key = unifiedDomainSessionKey("slack/T3/C3");
  const row = await store.rotateChannelSession(ORG, key, saltSupervisorGeneration(formatWindowToken({ domain: "slack/T3/C3", windowId: "slack/T3/C3", generation: 1 })), AT);
  const result = await rotateSeatCarryingTail(store, ORG, key, "2026-08-19T00:05:00.000Z");
  ok(result !== null, "an empty-ring row still rotates — it is not treated as an error");
  eq(result!.tailCarried, 0, "🔴 tailCarried is explicitly 0 (asserted as a value, not merely falsy/absent) — the bootstrap/empty-ring fallback");
  eq(result!.tail.length, 0, "…and the tail array is genuinely empty, not a fallback sentinel");
  eq(result!.newRow.generation, 2, "…while the rotation itself still succeeds and advances the generation");
  ok(result!.newToken !== row.token, "…with a fresh token, same as any other rotation");
}

{
  const result = await rotateSeatCarryingTail(store, ORG, unifiedDomainSessionKey("slack/NEVER-SEEN/C9"), AT);
  eq(result, null, "a registryKey with no channel_session row returns null — nothing to rotate, not an error");
}

{
  await store.rotateChannelSession(ORG, "slack/LEGACY/C9", saltSupervisorGeneration(formatWindowToken({ domain: "slack/LEGACY/C9", windowId: "slack/LEGACY/C9", generation: 1 })), AT);

  const domainRows = await store.listChannelSessions(ORG, "oe-domain::");
  ok(
    domainRows.every((r) => r.surfaceKey.startsWith("oe-domain::")),
    "listChannelSessions(org, 'oe-domain::') returns ONLY rows under that prefix",
  );
  ok(!domainRows.some((r) => r.surfaceKey === "slack/LEGACY/C9"), "…and excludes the non-prefixed legacy row");
  ok(
    domainRows.some((r) => r.surfaceKey === unifiedDomainSessionKey("slack/T1/C1")) &&
      domainRows.some((r) => r.surfaceKey === unifiedDomainSessionKey("slack/T2/C2")) &&
      domainRows.some((r) => r.surfaceKey === unifiedDomainSessionKey("slack/T3/C3")),
    "…and includes every oe-domain:: row seeded above",
  );

  const allRows = await store.listChannelSessions(ORG);
  ok(allRows.some((r) => r.surfaceKey === "slack/LEGACY/C9"), "omitting keyPrefix returns EVERY row, including the non-prefixed one");
  ok(allRows.length >= domainRows.length + 1, "…a strict superset of the prefixed listing");
}

{
  const keyA = unifiedDomainSessionKey("slack/S1/C1");
  const keyB = unifiedDomainSessionKey("slack/S2/C2");
  const rowA = await store.rotateChannelSession(ORG, keyA, saltSupervisorGeneration(formatWindowToken({ domain: "slack/S1/C1", windowId: "slack/S1/C1", generation: 1 })), AT);
  const rowB = await store.rotateChannelSession(ORG, keyB, saltSupervisorGeneration(formatWindowToken({ domain: "slack/S2/C2", windowId: "slack/S2/C2", generation: 1 })), AT);
  await store.appendSessionTail(ORG, keyA, rowA.token, wakeEntry("sweep question", "2026-08-18T23:00:00.000Z"));

  const org2 = "sweep-org";
  await store.rotateChannelSession(org2, keyA, saltSupervisorGeneration(formatWindowToken({ domain: "slack/S1/C1", windowId: "slack/S1/C1", generation: 1 })), AT);

  const { rotated, vanished } = await rotateAllSeatsCarryingTail(store, ORG, "2026-08-19T01:00:00.000Z");
  eq(vanished.length, 0, "nothing vanished mid-sweep in this single-threaded run");
  const rA = rotated.find((r) => r.registryKey === keyA);
  const rB = rotated.find((r) => r.registryKey === keyB);
  ok(rA !== undefined && rB !== undefined, "the sweep rotated BOTH rows seeded for this org's oe-domain:: prefix");
  eq(rA!.tailCarried, 1, "…carrying the populated row's one entry");
  eq(rB!.tailCarried, 0, "…and rotating the empty row cleanly (0 carried, not skipped)");
  ok(!rotated.some((r) => r.newRow.org !== undefined && (r.newRow as { org?: string }).org === org2), "sanity: nothing from this call touched org2's row shape");
  const otherOrgStillGen1 = await store.getChannelSession(org2, keyA);
  eq(otherOrgStillGen1!.generation, 1, "🔴 an org-scoped sweep NEVER rotates another org's row sharing the same registry key — org isolation holds");
}

assert.ok(passed > 0, "at least one assertion ran");
console.log(`✓ rotate-all-carry-tail: ${passed} assertions passed (carry-forward vs. raw-swap contrast, empty-ring negative control, no-row null, listChannelSessions prefix filter, end-to-end sweep, org isolation)`);
await closeAllTestPg();
