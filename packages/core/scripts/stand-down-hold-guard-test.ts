// A re-invitation clears a stop, then deletes that stop's stand-down hold. A new stop can land
// between the clear's read of the flag and its delete, and claim a fresh hold in the same row. The
// delete is `deleteTaskResultIfUnstopped`: ONE statement that deletes the hold only while it still
// holds the value the clear read AND the conversation's engagement row is not stopped. This test
// proves that store primitive on both store engines (sqlite and embedded Postgres). The race itself,
// through the real re-invitation and stand_down paths, is §13G of turn-closeout-test.ts.
process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const ORG = "default";
const AT = "2030-01-01T00:00:00.000Z";
const TTL = 60_000;
const SURFACE = "slack/T1/C1";
const THREAD = "1757172800.000100";
const OTHER_THREAD = "1757172800.000200";

async function suite(engine: string, store: OperationalStore): Promise<void> {
  const key = `oe-test-hold:${engine}`;
  const held = '{"holder":"a","claim":"c1"}';
  await store.markEngaged(ORG, SURFACE, THREAD, AT, { participating: true });
  await store.putTaskResult(ORG, key, held, AT, TTL);

  ok(await store.markStopped(ORG, SURFACE, THREAD), `${engine}: the engagement row is stopped`);
  ok(
    !(await store.deleteTaskResultIfUnstopped(ORG, key, held, SURFACE, THREAD)),
    `${engine}: 🔴 the guarded delete deletes nothing while the engagement row is stopped`,
  );
  ok((await store.getTaskResult(ORG, key)) === held, `${engine}: …and the row is unchanged`);
  ok(await store.deleteTaskResultIf(ORG, key, held), `${engine}: CONTROL: the unguarded delete of the same row deletes it`);

  await store.putTaskResult(ORG, key, held, AT, TTL);
  ok(
    await store.deleteTaskResultIfUnstopped(ORG, key, held, SURFACE, OTHER_THREAD),
    `${engine}: a stop on ANOTHER conversation does not guard this row, and a missing engagement row counts as not stopped`,
  );

  await store.putTaskResult(ORG, key, held, AT, TTL);
  await store.markEngaged(ORG, SURFACE, THREAD, AT, { participating: true, engagedBy: "evt-reinvite" });
  ok((await store.getEngagement(ORG, SURFACE, THREAD))?.stopped === false, `${engine}: a re-invitation clears the stop`);
  ok(
    !(await store.deleteTaskResultIfUnstopped(ORG, key, '{"holder":"a","claim":"stale"}', SURFACE, THREAD)),
    `${engine}: with the row not stopped, a stale value deletes nothing`,
  );
  ok(
    await store.deleteTaskResultIfUnstopped(ORG, key, held, SURFACE, THREAD),
    `${engine}: NEGATIVE CONTROL: with the row not stopped and the value current, the guarded delete deletes the row`,
  );
  ok((await store.getTaskResult(ORG, key)) === null, `${engine}: …and the row is gone`);
}

await suite("sqlite", sqliteOperationalStore);

const pgDir = mkdtempSync(join(tmpdir(), "oe-stand-down-hold-guard-"));
const pg = await openOperationalPglite(pgDir);
try {
  await initOperationalSchema(pg.client);
  await suite("postgres", registerOperationalPostgres(pg.client));
} finally {
  await pg.close();
}

console.log(`✓ stand-down-hold-guard: ${n} assertions passed`);
