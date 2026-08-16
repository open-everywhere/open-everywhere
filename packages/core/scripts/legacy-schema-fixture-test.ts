import assert from "node:assert/strict";
import { withLegacySqliteFixture, withLegacyPostgresFixture, type LegacySchemaFixture } from "./legacy-schema-fixture.js";
import { closeAllTestPg } from "./test-pg-driver.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const PRE_RENAME_CREDENTIAL_TABLES: LegacySchemaFixture = {
  sql: `
    CREATE TABLE stored_credential (
      org_id     TEXT NOT NULL,
      ref        TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      provider   TEXT,
      domain     TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claim_id   TEXT,
      claimed_at TEXT,
      PRIMARY KEY (org_id, ref)
    );
    CREATE TABLE credential_intake (
      org_id       TEXT NOT NULL,
      id           TEXT NOT NULL,
      ref          TEXT NOT NULL,
      provider     TEXT NOT NULL,
      domain       TEXT,
      requested_by TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      thread_ts    TEXT,
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      used_at      TEXT,
      PRIMARY KEY (org_id, id)
    );
    INSERT INTO stored_credential (org_id, ref, ciphertext, provider, domain, created_by, created_at)
      VALUES ('acme', 'db:notion-payments-key', 'ct-opaque-b64', 'notion', 'payments', 'U1', '2026-07-01T00:00:00Z');
    INSERT INTO credential_intake (org_id, id, ref, provider, domain, requested_by, channel_id, created_at, expires_at)
      VALUES ('acme', 'intake-legacy-1', 'db:notion-payments-key', 'notion', 'payments', 'U1', 'C1', '2026-07-01T00:00:00Z', '2026-07-01T00:15:00Z');
  `,
};

await withLegacySqliteFixture(PRE_RENAME_CREDENTIAL_TABLES, async (store) => {
  const cred = await store.getStoredCredential("acme", "db:notion-payments-key");
  ok(cred?.connector === "notion", "sqlite: a pre-rename stored_credential row reads back through `connector` after boot — the seeded `provider` value survived the RENAME COLUMN, not just the table");
  ok(cred?.ciphertext === "ct-opaque-b64" && cred?.domain === "payments" && cred?.createdBy === "U1", "sqlite: …and every other column on the same row is untouched by the migration");

  const intake = await store.getCredentialIntake("acme", "intake-legacy-1");
  ok(intake?.connector === "notion", "sqlite: a pre-rename credential_intake row also reads back through `connector`");

  await store.putStoredCredential("acme", { ref: "db:linear-payments-key", ciphertext: "ct-2", connector: "linear", domain: "payments", createdBy: "U2", createdAt: "2026-07-02T00:00:00Z" });
  const fresh = await store.getStoredCredential("acme", "db:linear-payments-key");
  ok(fresh?.connector === "linear", "sqlite: a NEW row, written after the migration ran, round-trips through the migrated table too");
});

await withLegacyPostgresFixture(PRE_RENAME_CREDENTIAL_TABLES, async (store) => {
  const cred = await store.getStoredCredential("acme", "db:notion-payments-key");
  ok(cred?.connector === "notion", "postgres: a pre-rename stored_credential row reads back through `connector` after boot");
  ok(cred?.ciphertext === "ct-opaque-b64" && cred?.domain === "payments" && cred?.createdBy === "U1", "postgres: …and every other column on the same row is untouched by the migration");

  const intake = await store.getCredentialIntake("acme", "intake-legacy-1");
  ok(intake?.connector === "notion", "postgres: a pre-rename credential_intake row also reads back through `connector`");

  await store.putStoredCredential("acme", { ref: "db:linear-payments-key", ciphertext: "ct-2", connector: "linear", domain: "payments", createdBy: "U2", createdAt: "2026-07-02T00:00:00Z" });
  const fresh = await store.getStoredCredential("acme", "db:linear-payments-key");
  ok(fresh?.connector === "linear", "postgres: a NEW row, written after the migration ran, round-trips through the migrated table too");
});
await closeAllTestPg();

console.log(`\n✓ legacy-schema-migration: ${n} assertions passed`);
