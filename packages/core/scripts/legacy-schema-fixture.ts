import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import type { OperationalStore } from "../agent/operational/store.js";
import { openTestPg } from "./test-pg-driver.js";

export interface LegacySchemaFixture {
  readonly sql: string;
}

export async function withLegacySqliteFixture<T>(fixture: LegacySchemaFixture, run: (store: OperationalStore) => Promise<T>): Promise<T> {
  const path = join(mkdtempSync(join(tmpdir(), "oe-legacy-sqlite-")), "legacy.sqlite3");
  const setup = new DatabaseSync(path);
  setup.exec(fixture.sql);
  setup.close();

  const prevPath = process.env.OE_SQLITE_PATH;
  process.env.OE_SQLITE_PATH = path;
  const { sqliteOperationalStore, sqliteOperationalTableNames, _resetOperationalDbForTest } = await import("../agent/operational/sqlite.js");
  _resetOperationalDbForTest();
  try {
    sqliteOperationalTableNames();
    return await run(sqliteOperationalStore);
  } finally {
    if (prevPath === undefined) delete process.env.OE_SQLITE_PATH;
    else process.env.OE_SQLITE_PATH = prevPath;
    _resetOperationalDbForTest();
  }
}

export async function withLegacyPostgresFixture<T>(fixture: LegacySchemaFixture, run: (store: OperationalStore, client: PgClient) => Promise<T>): Promise<T> {
  const pg = await openTestPg();
  await pg.exec(fixture.sql);
  await initOperationalSchema(pg.client);
  const store = makeOperationalPostgresStore(pg.client);
  return run(store, pg.client);
}
