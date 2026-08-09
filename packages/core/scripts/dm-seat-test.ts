import assert from "node:assert/strict";
import { getOrCreateDmSeat, touchDmSeat, dmSeatThresholds, DM_SEAT_ROTATE_TURN_BUDGET, DM_SEAT_ROTATE_TOKEN_BUDGET } from "../agent/channels/dm-seat.js";
import { SUPERVISOR_ROTATE_QUIET_GAP_MS, SUPERVISOR_ROTATE_TOKEN_BUDGET, SUPERVISOR_ROTATE_TURN_BUDGET } from "../agent/channels/turn-delivery.js";
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
const DM = { surfaceKey: SURFACE, legacyChannelId: DM_CHANNEL };

const REG = "oe-domain::oe-dm/slack/T1/D0EXDMCH001";
const LEGACY_REG = "oe-dm-seat::D0EXDMCH001";

function makeStore(...seeds: (Partial<ChannelSessionRow> & { surfaceKey: string })[]): OperationalStore & {
  rows: Map<string, ChannelSessionRow>;
} {
  const rows = new Map<string, ChannelSessionRow>();
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
      handoffNote: seed.handoffNote ?? null,
    });
  }
  const store = {
    rows,
    async getChannelSession(org: string, surfaceKey: string) {
      return rows.get(`${org}:${surfaceKey}`) ?? null;
    },
    async rotateChannelSession(org: string, surfaceKey: string, token: string, at: string, handoffNote?: string) {
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
        handoffNote: handoffNote ?? null,
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
    async bumpChannelSessionUsage(org: string, surfaceKey: string, token: string, delta: number) {
      const row = rows.get(`${org}:${surfaceKey}`);
      if (!row || row.token !== token) return 0;
      rows.set(`${org}:${surfaceKey}`, { ...row, inputTokensTotal: (row.inputTokensTotal ?? 0) + delta });
      return 1;
    },
  };
  return store as unknown as OperationalStore & { rows: Map<string, ChannelSessionRow> };
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
  ok(!store.rows.has(`${ORG}:${LEGACY_REG}`), "no OPE-90 `oe-dm-seat::` row is written — the legacy row is read at adopt, never maintained");

  ok(/:oe-sup:g1-[0-9a-f]{6}$/.test(seat.token), "the mint carries an OPE-58 rotation SALT — a re-used generation integer can never re-mint the same token");

  eq(seat.generation, 1, "adoption generation is 1");
  eq(seat.freshGeneration, true, "adoption is a fresh generation (first wake carries continuity)");
  eq(seat.handoffNote, null, "adoption with NO legacy row has NO handoff note (no outgoing generation to carry)");
}

{
  const store = makeStore({
    surfaceKey: LEGACY_REG,
    token: "D0EXDMCH001:oe-dm:g9",
    generation: 9,
    turnCount: 12,
    handoffNote: "alice was mid-refund on order 4417; she prefers terse answers",
    firstWakeAt: "2026-07-21T00:00:00.000Z",
  });
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });

  eq(
    seat.handoffNote,
    "alice was mid-refund on order 4417; she prefers terse answers",
    "🔴 THE MIGRATION PROPERTY: the legacy row's handoff note is CARRIED FORWARD onto the window seat — the forced re-seat is a rotation, not an amnesia event",
  );
  eq(seat.freshGeneration, true, "…and the seat is FRESH, so the front route renders that note as the first wake's context");
  ok(isDmAnchorWindowToken(seat.token), "the adopted seat is a window seat (the legacy token shape is not carried forward — only its continuity)");
  eq(store.rows.get(`${ORG}:${REG}`)!.handoffNote, seat.handoffNote, "the note is persisted on the NEW window row, so a re-read of an un-woken generation re-carries it (H7c)");

  eq(seat.generation, 1, "the window row starts at generation 1 — the store owns the counter, and the token agrees with the row it is stored in");
  eq(parseWindowToken(seat.token)!.generation, 1, "…token and row agree (the durable copy invariant)");

  eq(store.rows.get(`${ORG}:${LEGACY_REG}`)!.token, "D0EXDMCH001:oe-dm:g9", "the legacy row is untouched — the adopt READS it and never writes it, so a rollback finds its seat intact");
}

{
  const store = makeStore({ surfaceKey: LEGACY_REG, token: "D0EXDMCH001:oe-dm:g9", generation: 9, handoffNote: "carried?" });
  const seat = await getOrCreateDmSeat(ORG, { surfaceKey: SURFACE }, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.handoffNote, null, "no `legacyChannelId` ⇒ no legacy probe ⇒ no note: the migration read is an explicit affordance, never inferred from the surface key");
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
  const store = makeStore({
    surfaceKey: REG,
    token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g3-abc123",
    generation: 3,
    turnCount: DM_SEAT_ROTATE_TURN_BUDGET + 1,
    inputTokensTotal: 1_000,
    firstWakeAt: "2026-07-21T00:00:00.000Z",
    lastWakeAt: "2026-07-21T00:00:00.000Z",
    handoffNote: "prior rolling note",
  });
  let distillArgs: { scope: string; outgoing: ChannelSessionRow } | undefined;
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", {
    store,
    distillHandoff: async (scope, outgoing) => {
      distillArgs = { scope, outgoing };
      return "distilled DM continuity";
    },
  });
  eq(seat.generation, 4, "over-budget seat ROTATES to generation 4");
  eq(parseWindowToken(seat.token)!.generation, 4, "…and the new token carries that generation");
  eq(seat.freshGeneration, true, "a rotated generation is fresh (first wake carries the handoff)");
  eq(seat.handoffNote, "distilled DM continuity", "rotation carries the distilled handoff note");
  eq(distillArgs?.scope, SURFACE, "🔴 the distiller is scoped by the SURFACE KEY (which resolves a utility-model route), not the bare channel id (which resolves none)");
  ok(distillArgs?.outgoing.generation === 3, "distiller saw the outgoing (gen-3) row");
  ok(seat.token !== "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g3-abc123", "generation bump ⇒ DIFFERENT continuation token (eve forks the session)");
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
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", {
    store,
    distillHandoff: async () => {
      throw new Error("model down");
    },
  });
  eq(seat.generation, 2, "still rotates when the distiller throws");
  eq(seat.handoffNote, null, "fail-quiet ⇒ rotates note-less");
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
  eq(dmSeatThresholds().quietGapMs, Number.POSITIVE_INFINITY, "DM quiet-gap DISABLED (∞) by default — a DM retires on SIZE, never on idleness");
  eq(DM_SEAT_ROTATE_TURN_BUDGET, 50, "DM turn budget is 50 (the practical primary trigger)");
  eq(DM_SEAT_ROTATE_TOKEN_BUDGET, 5_000_000, "DM input-token budget is 5M (live-calibrated, OPE-92)");
  eq(dmSeatThresholds().turnBudget, DM_SEAT_ROTATE_TURN_BUDGET, "dmSeatThresholds() reports the DM turn budget (this is the object getOrCreateDmSeat actually passes to shouldRotate)");
  eq(dmSeatThresholds().tokenBudget, DM_SEAT_ROTATE_TOKEN_BUDGET, "…and the DM token budget");
  ok(dmSeatThresholds().quietGapMs !== SUPERVISOR_ROTATE_QUIET_GAP_MS, "🔴 the DM quiet-gap is NOT the channel supervisor's 24h — the mechanism unified, the policy did not");
  ok(DM_SEAT_ROTATE_TURN_BUDGET !== SUPERVISOR_ROTATE_TURN_BUDGET, "🔴 the DM turn budget is NOT the supervisor's");
  ok(DM_SEAT_ROTATE_TOKEN_BUDGET !== SUPERVISOR_ROTATE_TOKEN_BUDGET, "🔴 the DM token budget is NOT the supervisor's");
  const store = makeStore({
    surfaceKey: REG,
    token: "oe-dom:oe-dm/slack/T1/D0EXDMCH001:oe-sup:g7-ddd444",
    generation: 7,
    turnCount: DM_SEAT_ROTATE_TURN_BUDGET + 1,
    inputTokensTotal: 1_000,
    firstWakeAt: "2026-07-21T00:00:00.000Z",
    lastWakeAt: "2026-07-21T00:00:00.000Z",
  });
  ok(DM_SEAT_ROTATE_TURN_BUDGET + 1 <= SUPERVISOR_ROTATE_TURN_BUDGET, "…and that turn count is still WITHIN the supervisor's budget (so the next assertion is about the DM policy, not about any policy)");
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.generation, 8, "a seat over the DM turn budget but under the supervisor's ROTATES — the DM thresholds are the ones that bind");
}

console.log(`dm-seat-test: ${n} assertions passed`);
