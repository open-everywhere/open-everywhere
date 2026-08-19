
process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { readAudit } from "../agent/audit/audit.js";
import type { SessionTailEntry } from "../agent/channels/session-tail.js";
import { getOrCreateDmSeat, touchDmSeat, dmSeatThresholds, DM_SEAT_ROTATE_TURN_BUDGET, DM_SEAT_ROTATE_TOKEN_BUDGET, DM_SEAT_ROTATE_EXPIRY_MS } from "../agent/channels/dm-seat.js";
import { supervisorRotateQuietGapMs, supervisorRotateTokenBudget, supervisorRotateTurnBudget, supervisorRotateExpiryMs } from "../agent/channels/turn-delivery.js";
import {
  classifySessionId,
  parseWindowToken,
  isDmAnchorWindowToken,
  dmAnchorSurfaceForToken,
  isDmAnchoredTaskToken,
  dmSeatRegistryKey,
} from "../agent/channels/window-key.js";
import { dmWindowRegistryKey, standingSeatRegistryKey, isSupervisorToken } from "../agent/channels/unified-supervisor.js";
import { windowEnabledFor } from "../agent/channels/unified.js";
import type { ChannelSessionRow, OperationalStore } from "../agent/operational/store.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "acme";
const SURFACE = "slack/T1/D0EXDMCH001";
const DM_CHANNEL = "D0EXDMCH001";
const DM = { surfaceKey: SURFACE };

const REG = "oe-domain::oe-dm/slack/T1/D0EXDMCH001";
const LEGACY_REG = "oe-dm-seat::D0EXDMCH001";

function makeStore(...seeds: (Partial<ChannelSessionRow> & { surfaceKey: string })[]): OperationalStore & {
  rows: Map<string, ChannelSessionRow>;
  tail: Map<string, SessionTailEntry[]>;
} {
  const rows = new Map<string, ChannelSessionRow>();
  const tailRing = new Map<string, SessionTailEntry[]>();
  for (const seed of seeds) {
    rows.set(`${ORG}:${seed.surfaceKey}`, {
      org: ORG,
      surfaceKey: seed.surfaceKey,
      token: seed.token ?? "seed-token",
      generation: seed.generation ?? 1,
      createdAt: seed.createdAt ?? "2026-07-21T00:00:00.000Z",
      lastWakeAt: seed.lastWakeAt ?? "2026-07-21T00:00:00.000Z",
      turnCount: seed.turnCount ?? 0,
      inputTokensTotal: seed.inputTokensTotal ?? 0,
      firstWakeAt: seed.firstWakeAt ?? null,
      lastInputTokens: seed.lastInputTokens ?? null,
      rotateMarkedAt: seed.rotateMarkedAt ?? null,
    });
  }
  const store = {
    rows,
    async getChannelSession(org: string, surfaceKey: string) {
      return rows.get(`${org}:${surfaceKey}`) ?? null;
    },
    async rotateChannelSession(org: string, surfaceKey: string, token: string, at: string) {
      const prev = rows.get(`${org}:${surfaceKey}`);
      const row: ChannelSessionRow = {
        org,
        surfaceKey,
        token,
        generation: (prev?.generation ?? 0) + 1,
        createdAt: at,
        lastWakeAt: at,
        turnCount: 0,
        inputTokensTotal: 0,
        firstWakeAt: null,
        lastInputTokens: null,
        rotateMarkedAt: null,
      };
      rows.set(`${org}:${surfaceKey}`, row);
      return row;
    },
    async touchChannelSession(org: string, surfaceKey: string, at: string) {
      const row = rows.get(`${org}:${surfaceKey}`);
      if (!row) return;
      rows.set(`${org}:${surfaceKey}`, {
        ...row,
        lastWakeAt: at,
        turnCount: row.turnCount + 1,
        firstWakeAt: row.firstWakeAt ?? at,
      });
    },
    async claimNotice() {
      return false;
    },
    async bumpChannelSessionUsage(org: string, surfaceKey: string, token: string, delta: number) {
      const row = rows.get(`${org}:${surfaceKey}`);
      if (!row || row.token !== token) return 0;
      rows.set(`${org}:${surfaceKey}`, { ...row, inputTokensTotal: (row.inputTokensTotal ?? 0) + delta, lastInputTokens: delta });
      return 1;
    },
    tail: tailRing,
    async appendSessionTail(org: string, surfaceKey: string, token: string, entry: SessionTailEntry) {
      const key = `${org}:${surfaceKey}:${token}`;
      tailRing.set(key, [...(tailRing.get(key) ?? []), entry]);
    },
    async readSessionTail(org: string, surfaceKey: string, token: string) {
      return [...(tailRing.get(`${org}:${surfaceKey}:${token}`) ?? [])];
    },
    async clearSessionTail(org: string, surfaceKey: string, token: string) {
      tailRing.delete(`${org}:${surfaceKey}:${token}`);
    },
  };
  return store as unknown as OperationalStore & { rows: Map<string, ChannelSessionRow>; tail: Map<string, SessionTailEntry[]> };
}

{
  const store = makeStore();
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });

  const key = parseWindowToken(seat.token);
  ok(key !== undefined, "🔴 the seat's token is a WINDOW token (an ordinary five-segment token, not a bespoke kind)");
  eq(key!.domain, "oe-dm/slack/T1/D0EXDMCH001", "…on the `oe-dm/<surfaceKey>` pseudo-domain — the SAME anchor its workers use");
  eq(key!.windowId, key!.domain, "…DEGENERATE (windowId === domain): a DM seat is one window, not a window among many");
  eq(key!.generation, 1, "…at the first generation");
  eq(classifySessionId(seat.token).grain, "standing", "…and it classifies STANDING grain (a seat, not a worker)");

  ok(isDmAnchorWindowToken(seat.token), "🔴 isDmAnchorWindowToken is TRUE for a real minted seat token (stage 0/1 had no producer)");
  eq(dmAnchorSurfaceForToken(seat.token), SURFACE, "the admission seam recovers EXACTLY the DM's own surface key — the byte-exact privacy fence");
  ok(!isDmAnchoredTaskToken(seat.token), "…and it stays DISJOINT from the task-grain predicate: a seat can never be routed as one of its own workers");

  ok(store.rows.has(`${ORG}:${REG}`), "the seat is held in the WINDOW registry row (`oe-domain::oe-dm/<surfaceKey>`)");
  eq(dmWindowRegistryKey(SURFACE), REG, "…which is what dmWindowRegistryKey derives from the surface key");
  ok(isSupervisorToken(seat.token), "the token is supervisor-SHAPED, so hooks/spend.ts's supervisor branch owns its counter…");
  eq(standingSeatRegistryKey(seat.token, SURFACE), REG, "…and that branch's token-side key derivation lands on the SAME row (producer/consumer agree)");
  ok(!store.rows.has(`${ORG}:${LEGACY_REG}`), "no OPE-90 `oe-dm-seat::` row is written — the seat lives in the window registry only");

  ok(/:oe-sup:g1-[0-9a-f]{6}$/.test(seat.token), "the mint carries an OPE-58 rotation SALT — a re-used generation integer can never re-mint the same token");

  eq(seat.generation, 1, "adoption generation is 1");
  eq(seat.freshGeneration, true, "adoption is a fresh generation (first wake carries continuity)");
  eq(seat.tail.length, 0, "adoption carries NO tail — there is no outgoing generation to inherit from");
}

{
  const store = makeStore({ surfaceKey: LEGACY_REG, token: "D0EXDMCH001:oe-dm:g9", generation: 9 });
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.generation, 1, "adoption mints generation 1 on the WINDOW row, whatever a legacy row says");
  eq(seat.tail.length, 0, "…with an EMPTY tail: there is no outgoing generation, so the caller falls back to its own history fetch");
  ok(store.rows.has(`${ORG}:${REG}`), "the seat is held in the window registry row");
  eq(store.rows.get(`${ORG}:${LEGACY_REG}`)!.token, "D0EXDMCH001:oe-dm:g9", "the legacy row is not read and not written");
}

{
  const store = makeStore({
    surfaceKey: REG,
    token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g3-abc123",
    generation: 3,
    turnCount: 10,
    inputTokensTotal: 5_000,
    firstWakeAt: "2026-07-20T00:00:00.000Z",
    lastWakeAt: "2026-07-20T00:00:00.000Z",
  });
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.token, "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g3-abc123", "within-budget seat resumes the SAME token");
  eq(seat.generation, 3, "resume keeps the generation");
  eq(seat.freshGeneration, false, "a resumed seat whose first wake landed is NOT fresh");
  ok(dmSeatThresholds().quietGapMs === Number.POSITIVE_INFINITY, "default DM quiet-gap is DISABLED (∞) — a DM rotates on SIZE, not idleness");
  ok(!store.rows.has(`${ORG}:${LEGACY_REG}`), "a resume performs no legacy read at all (the window row exists, so the migration arm is unreachable)");
}

{
  const OUT_TOKEN = "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g3-abc123";
  const store = makeStore({
    surfaceKey: REG,
    token: OUT_TOKEN,
    generation: 3,
    turnCount: DM_SEAT_ROTATE_TURN_BUDGET + 1,
    inputTokensTotal: 1_000,
    firstWakeAt: "2026-07-21T00:00:00.000Z",
    lastWakeAt: "2026-07-21T00:00:00.000Z",
  });
  await store.appendSessionTail(ORG, REG, OUT_TOKEN, {
    kind: "wake", at: "2026-07-21T09:00:00.000Z", from: "human", trust: "principal", author: "alice", authorId: "U_ALICE", text: "any word on the 4417 refund?",
  });
  await store.appendSessionTail(ORG, REG, OUT_TOKEN, {
    kind: "post", at: "2026-07-21T09:00:05.000Z", from: "self", trust: "relay", author: "self", text: "chasing it with payments now",
  });

  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.generation, 4, "over-budget seat ROTATES to generation 4");
  eq(parseWindowToken(seat.token)!.generation, 4, "…and the new token carries that generation");
  eq(seat.freshGeneration, true, "a rotated generation is fresh (its first wake carries the tail)");
  eq(seat.tail.length, 2, "🔴 THE CONTINUITY PROPERTY: the outgoing generation's recorded tail is CARRIED FORWARD");
  eq(seat.tail[0]!.body, "any word on the 4417 refund?", "…oldest-first, so it reads as a conversation");
  eq(seat.tail[0]!.from, "human", "…the human's message renders as a human's");
  eq(seat.tail[1]!.from, "self", "🔴 …and the seat's OWN post renders `from=self` — it owns its words rather than reading them as channel documentation (OPE-795)");
  eq(store.tail.get(`${ORG}:${REG}:${OUT_TOKEN}`), undefined, "the outgoing ring is CLEARED once carried — it has served its only purpose");
  ok(seat.token !== OUT_TOKEN, "generation bump ⇒ DIFFERENT continuation token (eve forks the session)");
  eq(dmAnchorSurfaceForToken(seat.token), SURFACE, "a ROTATED token still admits to exactly its own DM surface — the fence survives rotation");
}

{
  const store = makeStore({
    surfaceKey: REG,
    token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g1-aaa111",
    generation: 1,
    turnCount: DM_SEAT_ROTATE_TURN_BUDGET + 5,
    inputTokensTotal: 0,
    firstWakeAt: "2026-07-21T00:00:00.000Z",
    lastWakeAt: "2026-07-21T00:00:00.000Z",
  });
  const failingRead = {
    ...store,
    readSessionTail: async () => {
      throw new Error("store blip");
    },
  } as unknown as OperationalStore;
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store: failingRead });
  eq(seat.generation, 2, "still rotates when the tail read throws");
  eq(seat.tail.length, 0, "fail-soft ⇒ rotates tail-less, and the caller falls back to a platform fetch");
}

{
  const store = makeStore({
    surfaceKey: REG,
    token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g2-bbb222",
    generation: 2,
    turnCount: 3,
    inputTokensTotal: dmSeatThresholds().tokenBudget + 1,
    firstWakeAt: "2026-07-21T00:00:00.000Z",
    lastWakeAt: "2026-07-21T00:00:00.000Z",
  });
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.generation, 3, "input-token budget over threshold ⇒ rotate");
}

{
  const store = makeStore({ surfaceKey: REG, token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g1-ccc333", generation: 1, turnCount: 0, firstWakeAt: null });
  await touchDmSeat(ORG, SURFACE, "2026-07-22T10:00:00.000Z", store);
  const row = store.rows.get(`${ORG}:${REG}`)!;
  eq(row.turnCount, 1, "touch bumps turnCount on the WINDOW row (surface-keyed, like the mint)");
  eq(row.firstWakeAt, "2026-07-22T10:00:00.000Z", "touch stamps first_wake_at (once)");
}

{
  ok(dmWindowRegistryKey(SURFACE) !== dmSeatRegistryKey(DM_CHANNEL), "the window row and the legacy OPE-90 row are DIFFERENT keys — the adopt reads one and writes the other");
}

{
  const store = makeStore();
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });

  ok(windowEnabledFor(SURFACE, seat.token), "a freshly-minted DM seat token IS admitted for its own DM surface (a seat that cannot be delivered to is not a seat)");
  ok(!windowEnabledFor("slack/T1/D_OTHER", seat.token), "🔴 …and REFUSED for another DM in the same workspace — one person's DM window can never deliver into another's");
  ok(!windowEnabledFor("slack/T1/C_PAY", seat.token), "🔴 …refused for a real channel — a DM window cannot open a shared room");
  ok(!windowEnabledFor("slack/T2/D0EXDMCH001", seat.token), "🔴 …refused for the same channel id in a DIFFERENT workspace — the fence is the whole surface key, not the trailing segment");
  ok(windowEnabledFor(SURFACE, `unified:${seat.token}`), "…and the check survives eve's `unified:` send-prefix, which is the form the gate actually sees at dispatch");

  ok(seat.token.includes("-") && windowEnabledFor(SURFACE, seat.token), "the OPE-58 rotation salt on a real mint does NOT defeat the gate's parse (mint and gate agree on the salted spelling)");
}

{
  eq(dmSeatThresholds().quietGapMs, Number.POSITIVE_INFINITY, "DM quiet-gap DISABLED (∞) by default — a DM never retires on idleness alone");
  eq(DM_SEAT_ROTATE_EXPIRY_MS, 30 * 86_400_000, "DM expiry clock is 30 days (the PRIMARY trigger since OPE-345)");
  eq(DM_SEAT_ROTATE_TURN_BUDGET, 50, "DM turn BACKSTOP is 50");
  eq(DM_SEAT_ROTATE_TOKEN_BUDGET, 5_000_000, "DM input-token BACKSTOP is 5M (live-calibrated, OPE-92)");
  eq(dmSeatThresholds().expiryMs, DM_SEAT_ROTATE_EXPIRY_MS, "dmSeatThresholds() reports the DM expiry clock (this is the object getOrCreateDmSeat actually passes to shouldRotate — an omission here would silently give every DM the unified window's 7d clock)");
  eq(dmSeatThresholds().turnBudget, DM_SEAT_ROTATE_TURN_BUDGET, "…and the DM turn backstop");
  eq(dmSeatThresholds().tokenBudget, DM_SEAT_ROTATE_TOKEN_BUDGET, "…and the DM token backstop");
  ok(dmSeatThresholds().quietGapMs !== supervisorRotateQuietGapMs(), "🔴 the DM quiet-gap is NOT the channel supervisor's 24h — the mechanism unified, the policy did not");
  ok(DM_SEAT_ROTATE_EXPIRY_MS !== supervisorRotateExpiryMs(), "🔴 the DM expiry clock is NOT the unified window's");
  ok(DM_SEAT_ROTATE_TURN_BUDGET !== supervisorRotateTurnBudget(), "🔴 the DM turn backstop is NOT the supervisor's");
  ok(DM_SEAT_ROTATE_TOKEN_BUDGET !== supervisorRotateTokenBudget(), "🔴 the DM token backstop is NOT the supervisor's");
  const store = makeStore({
    surfaceKey: REG,
    token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g7-ddd444",
    generation: 7,
    turnCount: DM_SEAT_ROTATE_TURN_BUDGET + 1,
    inputTokensTotal: 1_000,
    firstWakeAt: "2026-07-21T00:00:00.000Z",
    lastWakeAt: "2026-07-21T00:00:00.000Z",
  });
  ok(DM_SEAT_ROTATE_TURN_BUDGET + 1 <= supervisorRotateTurnBudget(), "…and that turn count is still WITHIN the supervisor's budget (so the next assertion is about the DM policy, not about any policy)");
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.generation, 8, "a seat over the DM turn budget but under the supervisor's ROTATES — the DM thresholds are the ones that bind");
}

{
  const CREATED = "2026-06-01T00:00:00.000Z";
  const seed = {
    surfaceKey: REG,
    token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g2-eee555",
    generation: 2,
    createdAt: CREATED,
    turnCount: 3,
    inputTokensTotal: 1_000,
    firstWakeAt: CREATED,
    lastWakeAt: CREATED,
  };
  const resumed = await getOrCreateDmSeat(ORG, DM, "2026-06-11T00:00:00.000Z", { store: makeStore(seed) });
  eq(resumed.generation, 2, "🔴 a 10-day-old DM generation RESUMES — it is past the unified window's clock and nowhere near the DM's, and the DM's is the one that binds");
  eq(resumed.token, seed.token, "…on the very same continuation token (no silent fork)");

  const rotated = await getOrCreateDmSeat(ORG, DM, "2026-07-02T00:00:00.000Z", { store: makeStore(seed) });
  eq(rotated.generation, 3, "…and at 31 days the DM's OWN clock retires it, with no turn or token pressure whatsoever");
  ok(rotated.freshGeneration, "an expiry rotation is a fresh generation like any other (its first wake carries the tail)");
}

console.log(`dm-seat-test: ${n} assertions passed`);
