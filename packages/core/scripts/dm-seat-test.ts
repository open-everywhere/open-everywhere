import assert from "node:assert/strict";
import { getOrCreateDmSeat, touchDmSeat, dmSeatThresholds, DM_SEAT_ROTATE_TURN_BUDGET } from "../agent/channels/dm-seat.js";
import { classifySessionId, parseDmSeatToken } from "../agent/channels/window-key.js";
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
const DM = "D0EXDMCH001";

function makeStore(seed?: Partial<ChannelSessionRow> & { surfaceKey: string }): OperationalStore & {
  rows: Map<string, ChannelSessionRow>;
} {
  const rows = new Map<string, ChannelSessionRow>();
  if (seed) {
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
      if (!row || row.token !== token) return;
      rows.set(`${org}:${surfaceKey}`, { ...row, inputTokensTotal: (row.inputTokensTotal ?? 0) + delta });
    },
  };
  return store as unknown as OperationalStore & { rows: Map<string, ChannelSessionRow> };
}

const REG = "oe-dm-seat::D0EXDMCH001";

{
  const store = makeStore();
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.token, "D0EXDMCH001:oe-dm:g1", "adoption mints generation-1 seat token");
  eq(seat.generation, 1, "adoption generation is 1");
  eq(seat.freshGeneration, true, "adoption is a fresh generation (first wake carries continuity)");
  eq(seat.handoffNote, null, "adoption has NO handoff note (no outgoing generation to distil)");
  ok(store.rows.has(`${ORG}:${REG}`), "adoption created the registry row");
  eq(classifySessionId(seat.token).kind, "dm-seat", "adopted token classifies dm-seat");
}

{
  const store = makeStore({
    surfaceKey: REG,
    token: "D0EXDMCH001:oe-dm:g3",
    generation: 3,
    turnCount: 10,
    inputTokensTotal: 5_000,
    firstWakeAt: "2026-07-20T00:00:00.000Z",
    lastWakeAt: "2026-07-20T00:00:00.000Z",
  });
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", { store });
  eq(seat.token, "D0EXDMCH001:oe-dm:g3", "within-budget seat resumes the SAME token");
  eq(seat.generation, 3, "resume keeps the generation");
  eq(seat.freshGeneration, false, "a resumed seat whose first wake landed is NOT fresh");
  ok(dmSeatThresholds().quietGapMs === Number.POSITIVE_INFINITY, "default DM quiet-gap is DISABLED (∞)");
}

{
  const store = makeStore({
    surfaceKey: REG,
    token: "D0EXDMCH001:oe-dm:g3",
    generation: 3,
    turnCount: DM_SEAT_ROTATE_TURN_BUDGET + 1,
    inputTokensTotal: 1_000,
    firstWakeAt: "2026-07-21T00:00:00.000Z",
    lastWakeAt: "2026-07-21T00:00:00.000Z",
    handoffNote: "prior rolling note",
  });
  let distillArgs: { channelId: string; outgoing: ChannelSessionRow } | undefined;
  const seat = await getOrCreateDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", {
    store,
    distillHandoff: async (channelId, outgoing) => {
      distillArgs = { channelId, outgoing };
      return "distilled DM continuity";
    },
  });
  eq(seat.token, "D0EXDMCH001:oe-dm:g4", "over-budget seat ROTATES to generation 4 (new token)");
  eq(seat.generation, 4, "rotation increments the generation");
  eq(seat.freshGeneration, true, "a rotated generation is fresh (first wake carries the handoff)");
  eq(seat.handoffNote, "distilled DM continuity", "rotation carries the distilled handoff note");
  ok(distillArgs?.channelId === DM && distillArgs?.outgoing.generation === 3, "distiller saw the outgoing (gen-3) row");
  ok(seat.token !== "D0EXDMCH001:oe-dm:g3", "generation bump ⇒ DIFFERENT continuation token (eve forks the session)");
  eq(parseDmSeatToken(seat.token)?.generation, 4, "the new token parses to generation 4");
}

{
  const store = makeStore({
    surfaceKey: REG,
    token: "D0EXDMCH001:oe-dm:g1",
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
    token: "D0EXDMCH001:oe-dm:g2",
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
  const store = makeStore({ surfaceKey: REG, token: "D0EXDMCH001:oe-dm:g1", generation: 1, turnCount: 0, firstWakeAt: null });
  await touchDmSeat(ORG, DM, "2026-07-22T10:00:00.000Z", store);
  const row = store.rows.get(`${ORG}:${REG}`)!;
  eq(row.turnCount, 1, "touch bumps turnCount");
  eq(row.firstWakeAt, "2026-07-22T10:00:00.000Z", "touch stamps first_wake_at (once)");
}

console.log(`dm-seat-test: ${n} assertions passed`);
