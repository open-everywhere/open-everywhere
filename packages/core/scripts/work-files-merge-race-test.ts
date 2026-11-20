// A task's files row (`oe-work-files:<requestId>`) takes the files of every continuation that
// reaches its worker. Two continuations of one task can merge at the same time. Each merge reads the
// row before the other writes it, so a plain read-merge-write loses the first writer's files. The
// merge writes with a compare-and-set on the head row it read (`casTaskResult`), and the loser of
// the race reads again. This test races two merges on both store engines (sqlite and embedded
// Postgres), and proves the store primitive itself on both.
process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeWorkAttachments, readWorkAttachmentsKnown, type WorkFilesStore } from "../agent/channels/work.js";
import type { BriefAttachment } from "../agent/channels/attachments.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { openOperationalPglite } from "../agent/operational/pglite-client.js";
import { initOperationalSchema } from "../agent/operational/postgres.js";
import { registerOperationalPostgres } from "../agent/operational/provider.js";
import type { OperationalStore } from "../agent/operational/store.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "default";
const AT = "2030-01-01T00:00:00.000Z";
const TTL = 60_000;
const file = (id: string): BriefAttachment => ({ id, kind: "file", name: `${id}.csv` });
const ids = (files: readonly BriefAttachment[] | undefined): string[] | undefined => files?.map((f) => f.id).sort();

/**
 * A store whose first `parties` reads of `key` each wait until all of them have read. So every
 * party reads the row before any party writes it: the race happens on every run, not by chance.
 */
function racingStore(store: WorkFilesStore, key: string, parties: number): WorkFilesStore {
  let waiting = parties;
  let release!: () => void;
  const allRead = new Promise<void>((resolve) => (release = resolve));
  return {
    putTaskResult: (...a) => store.putTaskResult(...a),
    casTaskResult: (...a) => store.casTaskResult(...a),
    getTaskResult: async (org, k) => {
      const raw = await store.getTaskResult(org, k);
      if (k === key && waiting > 0) {
        waiting--;
        if (waiting === 0) release();
        await allRead;
      }
      return raw;
    },
  };
}

async function suite(engine: string, store: OperationalStore): Promise<void> {
  // The store primitive.
  const k = `oe-test-cas:${engine}`;
  ok(await store.casTaskResult(ORG, k, '{"v":1}', AT, TTL, null), `${engine}: cas with expected null writes an absent row`);
  ok(!(await store.casTaskResult(ORG, k, '{"v":2}', AT, TTL, null)), `${engine}: cas with expected null refuses a present row`);
  eq(await store.getTaskResult(ORG, k), '{"v":1}', `${engine}: …and keeps the row`);
  ok(!(await store.casTaskResult(ORG, k, '{"v":3}', AT, TTL, '{"v":0}')), `${engine}: cas with a stale expected value refuses the write`);
  eq(await store.getTaskResult(ORG, k), '{"v":1}', `${engine}: …and keeps the row`);
  ok(await store.casTaskResult(ORG, k, '{"v":4}', AT, TTL, '{"v":1}'), `${engine}: cas with the current value writes`);
  eq(await store.getTaskResult(ORG, k), '{"v":4}', `${engine}: …the new value`);
  ok(!(await store.casTaskResult(ORG, `${k}-absent`, '{"v":5}', AT, TTL, '{"v":4}')), `${engine}: cas with an expected value refuses an absent row`);
  eq(await store.getTaskResult(ORG, `${k}-absent`), null, `${engine}: …and writes no row`);

  // Two continuations of one task merge their files into one row at the same time.
  const req = `req-race-${engine}`;
  const key = `oe-work-files:${req}`;
  await store.putTaskResult(ORG, key, JSON.stringify({ attachments: [file("F0OPENING")] }), AT, TTL);
  const race = racingStore(store, key, 2);
  const results = await Promise.all([mergeWorkAttachments(race, ORG, req, [file("F0CONTA")], AT), mergeWorkAttachments(race, ORG, req, [file("F0CONTB")], AT)]);
  eq(results, [true, true], `${engine}: fixture: both merges report their files written`);
  eq(ids(await readWorkAttachmentsKnown(store, ORG, req)), ["F0CONTA", "F0CONTB", "F0OPENING"], `🔴 ${engine}: two concurrent merges both keep their files in the task's row`);

  // RACE CONTROL: the same race with a write that ignores the expected value loses a file. This
  // proves the barrier forces the interleaving, so the race assertions above can fail.
  const ctl = `req-race-control-${engine}`;
  const ctlKey = `oe-work-files:${ctl}`;
  await store.putTaskResult(ORG, ctlKey, JSON.stringify({ attachments: [file("F0CTLOPEN")] }), AT, TTL);
  const ctlRace = racingStore(store, ctlKey, 2);
  const blind: WorkFilesStore = { ...ctlRace, casTaskResult: async (o, k, j, a, t) => (await store.putTaskResult(o, k, j, a, t), true) };
  await Promise.all([mergeWorkAttachments(blind, ORG, ctl, [file("F0CTLA")], AT), mergeWorkAttachments(blind, ORG, ctl, [file("F0CTLB")], AT)]);
  const ctlIds = ids(await readWorkAttachmentsKnown(store, ORG, ctl)) ?? [];
  ok(ctlIds.includes("F0CTLOPEN") && ctlIds.includes("F0CTLA") !== ctlIds.includes("F0CTLB"), `🔴 RACE CONTROL ${engine}: a plain write under the same race keeps exactly one of the two files`);

  // The same race on an absent row: both merges try to create it.
  const fresh = `req-race-absent-${engine}`;
  const freshRace = racingStore(store, `oe-work-files:${fresh}`, 2);
  await Promise.all([mergeWorkAttachments(freshRace, ORG, fresh, [file("F0NEWA")], AT), mergeWorkAttachments(freshRace, ORG, fresh, [file("F0NEWB")], AT)]);
  eq(ids(await readWorkAttachmentsKnown(store, ORG, fresh)), ["F0NEWA", "F0NEWB"], `🔴 ${engine}: two concurrent merges into an absent row both keep their files`);

  // A row that links an earlier job's row: the race keeps the linked files too.
  const linked = `req-race-linked-${engine}`;
  const earlier = `req-race-earlier-${engine}`;
  await store.putTaskResult(ORG, `oe-work-files:${earlier}`, JSON.stringify({ attachments: [file("F0EARLIER")] }), AT, TTL);
  await store.putTaskResult(ORG, `oe-work-files:${linked}`, JSON.stringify({ attachments: [file("F0LINKED")], from: earlier }), AT, TTL);
  const linkedRace = racingStore(store, `oe-work-files:${linked}`, 2);
  await Promise.all([mergeWorkAttachments(linkedRace, ORG, linked, [file("F0LINKA")], AT), mergeWorkAttachments(linkedRace, ORG, linked, [file("F0LINKB")], AT)]);
  eq(ids(await readWorkAttachmentsKnown(store, ORG, linked)), ["F0EARLIER", "F0LINKA", "F0LINKB", "F0LINKED"], `🔴 ${engine}: a concurrent merge on a linked row keeps the linked files`);
  const order = (await readWorkAttachmentsKnown(store, ORG, linked))?.map((f) => f.id) ?? [];
  ok(order.indexOf("F0EARLIER") < order.indexOf("F0LINKED"), `${engine}: the earlier job's files stay first, so the cap evicts the oldest file`);

  // NEGATIVE CONTROL: one merge alone writes exactly its files, and nothing else.
  const solo = `req-solo-${engine}`;
  await store.putTaskResult(ORG, `oe-work-files:${solo}`, JSON.stringify({ attachments: [file("F0SOLOOPEN")] }), AT, TTL);
  ok(await mergeWorkAttachments(store, ORG, solo, [file("F0SOLOONE")], AT), `${engine}: fixture: the single merge writes`);
  eq(
    await store.getTaskResult(ORG, `oe-work-files:${solo}`),
    JSON.stringify({ attachments: [file("F0SOLOOPEN"), file("F0SOLOONE")] }),
    `🔴 NEGATIVE CONTROL ${engine}: one merge writes exactly the earlier files plus its own, in order`,
  );
  const before = await store.getTaskResult(ORG, `oe-work-files:${solo}`);
  ok(await mergeWorkAttachments(store, ORG, solo, [file("F0SOLOONE")], AT), `${engine}: a replayed merge reports its files present`);
  eq(await store.getTaskResult(ORG, `oe-work-files:${solo}`), before, `${engine}: …and writes nothing, so the order does not change`);

  // A merge whose read fails writes nothing.
  const broken: WorkFilesStore = {
    putTaskResult: (...a) => store.putTaskResult(...a),
    casTaskResult: (...a) => store.casTaskResult(...a),
    getTaskResult: async () => {
      throw new Error("the store read failed");
    },
  };
  ok(!(await mergeWorkAttachments(broken, ORG, solo, [file("F0BROKEN")], AT)), `${engine}: a merge whose read fails reports no write`);
  eq(await store.getTaskResult(ORG, `oe-work-files:${solo}`), before, `${engine}: …and the row keeps every earlier file`);

  // A merge that loses every attempt gives up and reports it; it never forces its write.
  const contended: WorkFilesStore = { ...broken, getTaskResult: (...a) => store.getTaskResult(...a), casTaskResult: async () => false };
  ok(!(await mergeWorkAttachments(contended, ORG, solo, [file("F0CONTENDED")], AT)), `${engine}: a merge that loses every attempt reports no write`);
  eq(await store.getTaskResult(ORG, `oe-work-files:${solo}`), before, `${engine}: …and never overwrites the row`);
}

await suite("sqlite", sqliteOperationalStore);

const pgDir = mkdtempSync(join(tmpdir(), "oe-work-files-race-"));
const pg = await openOperationalPglite(pgDir);
try {
  await initOperationalSchema(pg.client);
  await suite("postgres", registerOperationalPostgres(pg.client));
} finally {
  await pg.close();
}

console.log(`✓ work-files-merge-race: ${n} assertions passed`);
